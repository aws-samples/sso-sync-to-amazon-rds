import os
import logging
import json
import boto3
from lambda_utils import connection_manager
from lambda_utils.sql_executor import MySQLExecutor as ME

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

    # Init MySQL executor
    mysql_executor = ME(MYSQL_CONN)

    # Check if the user exists in the MySQL db
    managed_user = False
    user_exists = check_if_user_exists(user_name, mysql_executor)

    # Check if managed (exists in DynamoDB) only when exists in the MySQL db
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

    # Create user in the MySQL db
    try:
        create_mysql_user(user_name, mysql_executor)
    except Exception as err:
        logger.error("Failed to create MySQL user")
        logger.error(err)
        raise Exception("Failed to create MySQL user") from err

    # Grant role to the user
    try:
        grant_mysql_role(user_name, role_name, mysql_executor)
    except Exception as err:
        logger.error("Failed to grant MySQL role. Does the role %s exist in the DB?", role_name)
        logger.error(err)
        # Rollback if user didn't exist before
        if safe_to_delete:
            rollback(user_name, mysql_executor)
            logger.info("Changes rolled back")
        # Otherwise it's not safe to delete user
        else:
            logger.info("Not safe to rollback. Not deleting the user")
        raise Exception("Failed to grant MySQL role") from err

    # Add user mapping to DynamoDB if it doesn't exist
    if not managed_user:
        try:
            create_user_mapping(user_id=user_id, user_name=user_name, ddb_table=DDB_TABLE)
        # Rollback on error
        except Exception as err:
            logger.info("Rolling back changes")
            rollback(user_name, mysql_executor)
            logger.error(err)
            raise Exception("Failed to create user in DynamoDB") from err

    return {"status": "Success"}

def get_user_info(event_details, group_ids):
    """
    Gets user details from IAM Identity Center using user_id
    Returns username and user ID if user exists and belongs to a certain group
    Returns None and user ID otherwise
    """

    group_matches = False

    # Always adding user to a group (even on user creation)
    user_id = event_details['requestParameters']['member']['memberId']
    _group_id = event_details['requestParameters']['groupId']
    group_matches = _group_id in group_ids.keys()

    logger.info("Received new add user to group event with user_id %s", user_id)

    # The IAM Identity Center group is not configured for this function
    # Normally shouldn't happen
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

def rollback(user_name, mysql_executor):
    """
    Deletes MySQL user
    """

    logger.info("Deleting user %s from the DB", user_name)
    drop_user_q = f"DROP USER IF EXISTS '{user_name}';"

    mysql_executor.write(drop_user_q, friendly_name="drop user")

    logging.info("Deleted user from the database")

def grant_mysql_role(user_name, role, mysql_executor):
    """
    Grants role to the user
    """

    logger.info("Granting role %s to user %s", role, user_name)
    grant_q = f"GRANT '{role}' TO '{user_name}'@'%';"

    mysql_executor.write(grant_q, friendly_name="grant role")

    logger.info("Successfully granted role to the user")

def create_mysql_user(user_name, mysql_executor):
    """
    Creates MySQL user
    Grants role to the user
    """

    logger.info("Creating user %s in the DB", user_name)
    create_user_q = f"CREATE USER IF NOT EXISTS '{user_name}' IDENTIFIED WITH AWSAuthenticationPlugin as 'RDS';"

    mysql_executor.write(create_user_q, friendly_name="create user")

    logger.info("Created RDS user %s", user_name)

def check_if_user_exists(user_name, mysql_executor):
    """
    Checks if user exists in  the MySQL database
    """

    user_exists = False
    select_user_q = f"SELECT user FROM mysql.user WHERE user = '{user_name}';"

    try:
        row_count = mysql_executor.count_rows(select_user_q, friendly_name="select user")
        if row_count >= 1:
            user_exists = True
    except Exception:
        logger.warning("Couldn't determine wether the user already exists in the DB")
        logger.warning("Assuming user exists as a fail-safe")
        user_exists = True

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
        logger.warning("Assuming the user is not managed")

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
        logger.error("Failed to save user mapping to DDB")
        logger.error(err)
        raise Exception("Failed to save user mapping to DDB") from err

    logger.info("Successfully created user ID to username mapping")
