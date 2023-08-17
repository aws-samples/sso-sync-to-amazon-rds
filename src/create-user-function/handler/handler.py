import os
import logging
import json
import boto3
from lambda_utils import connection_manager

logger = logging.getLogger()
logger.setLevel(logging.INFO)
MYSQL_CONN = None
DDB_TABLE = None

def handler(event, context):
    """Handler function, entry point for Lambda"""

    global MYSQL_CONN
    global DDB_TABLE

    # A specific set of groups will trigger RDS user creation
    group_ids = json.loads(os.environ.get('IDENTITYSTORE_GROUP_IDS'))
    event_group_id = event['detail']['requestParameters']['groupId']
    user_name, user_id = get_user_info(event['detail'], group_ids)
    role_name = group_ids[event_group_id]

    # User does not exist or not in the specified group ID
    if user_name is None:
        logger.info("Not adding user to RDS")
        return {"status": "Success"}

    # Init DynamoDB table if doesn't exist
    if DDB_TABLE is None:
        DDB_TABLE = connection_manager.get_ddb_table()

    # Init MySQL connection if doesn't exist
    if MYSQL_CONN is None:
        MYSQL_CONN = connection_manager.get_mysql_connection()

    # Check if the user exists and managed
    managed_user = False
    user_exists = check_if_user_exists(user_name, MYSQL_CONN)

    # Check if managed only when exists
    if user_exists:
        managed_user = check_if_managed_user(user_id, user_name, DDB_TABLE)

    # If user exists but not managed, don't modify it
    if user_exists and not managed_user:
        logger.error("User already exists in MySQL database, but not managed. Exiting")
        return {"status": "Success"}

    # Safe to delete on rollback by default
    safe_to_delete = True
    # Not safe to delete if user already exists
    if user_exists and managed_user:
        logger.warning("User already exists in MySQL database")
        safe_to_delete = False

    # Create user in MySQL db and user mapping in DynamoDB
    create_mysql_user(user_name, role=role_name, mysql_conn=MYSQL_CONN,
                      safe_to_delete=safe_to_delete)

    # Add user mapping if it doesn't exist
    if not managed_user:
        create_user_mapping(user_id=user_id, user_name=user_name, ddb_table=DDB_TABLE)

    return {"status": "Success"}

def get_user_info(event_details, group_ids):
    """
    Gets user details from IAM Identity Center using user_id
    Returns username and user ID if user exists and belongs to a certain group
    Returns None and user ID otherwise
    """

    group_matches = False

    # Always adding user to a group
    user_id = event_details['requestParameters']['member']['memberId']
    _group_id = event_details['requestParameters']['groupId']
    group_matches = _group_id in group_ids.keys()

    logger.info("Received new add user to group event with user_id %s", user_id)

    if not group_matches:
        logger.warning("User is not part of a requested group id %s", _group_id)
        return None, user_id

    identitystore_id = event_details['requestParameters']['identityStoreId']
    client = boto3.client('identitystore')

    logger.info("Fetching user ID from Identity Store")
    user_data = client.describe_user(
        IdentityStoreId=identitystore_id,
        UserId=user_id
    )

    if not user_data:
        logger.error("Failed to get user data for user id %s", user_id)
        return None, user_id

    user_name = user_data.get('UserName', None)

    return user_name, user_id

def create_mysql_user(user_name, role, mysql_conn, safe_to_delete=False):
    """
    Creates MySQL user
    Manages MySQL connections
    Raises exception if not successful
    """

    logger.info("Creating user %s in the DB", user_name)

    # Create user and grant role
    create_user_q = f"CREATE USER IF NOT EXISTS '{user_name}' IDENTIFIED WITH AWSAuthenticationPlugin as 'RDS';"
    grant_q = f"GRANT '{role}' TO '{user_name}'@'%';"

    # Rollback user creation if SQL statements fail
    drop_user_q = f"DROP USER IF EXISTS '{user_name}';"

    # Create user and assign role
    try:
        cursor = mysql_conn.cursor()
        cursor.execute(create_user_q)
        cursor.execute(grant_q)
    except Exception as err:
        logger.error(err)
        # Rollback changes only when sure user didn't exist before
        if safe_to_delete:
            cursor.execute(drop_user_q)
            logger.info("Changes rolled back")
        raise Exception("Failed to execute SQL queries") from err
    finally:
        cursor.close()

    logger.info("Created RDS user %s", user_name)

def check_if_user_exists(user_name, mysql_conn):
    """
    Checks if user exists in  the MySQL database
    """

    user_exists = False
    select_user_q = f"SELECT user FROM mysql.user WHERE user = '{user_name}';"

    # Check if user already exists
    try:
        cursor = mysql_conn.cursor()
        cursor.execute(select_user_q)
        cursor.fetchall()
        row_count = cursor.rowcount
        if row_count >= 1:
            user_exists = True
    except Exception as err:
        logger.error(err)
        logger.warning("Couldn't determine wether the user already exists in the DB")
        logger.warning("Assuming user exists as a fail-safe")
        user_exists = True
    finally:
        cursor.close()

    return user_exists

def check_if_managed_user(user_id, user_name, ddb_table):
    """
    Checks if user mapping already exists in DynamoDB
    This allows to determine wether the user is managed by the solution or not
    """

    logger.info("Fetching user %s from DDB", user_name)
    managed_user = False

    try:
        resp = ddb_table.get_item(
            Key={
                'userID': user_id
            }
        )
        user_data = resp.get('Item')
        # If record exists in DDB, the user is managed
        if user_data is not None:
            managed_user = True
    # Keep user as not managed as a fail-safe
    except Exception as err:
        logger.error("Failed to get user mapping from DDB")
        logger.error(err)

    return managed_user

def create_user_mapping(user_id, user_name, ddb_table):
    """
    Creates user ID to username mapping in DynamoDB
    Manages DDB connections
    Raises exception if not successful
    """

    logger.info("Creating user ID to username mapping in DDB for user %s", user_name)

    try:
        item = {'userID': user_id, 'username': user_name}
        ddb_table.put_item(Item=item)
    except Exception as err:
        raise Exception("Failed to save user mapping to DDB") from err

    logger.info("Successfully created user ID to username mapping")
