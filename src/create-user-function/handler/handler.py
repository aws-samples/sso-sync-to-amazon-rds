import os
import logging
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

    # One specific group will trigger RDS user creation
    group_id = os.environ['IDENTITYSTORE_GROUP_ID']
    user_name, user_id = get_user_info(event['detail'], group_id)

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

    # Create user in MySQL db and user mapping in DynamoDB
    create_mysql_user(user_name, mysql_conn=MYSQL_CONN)
    create_user_mapping(user_id=user_id, user_name=user_name, ddb_table=DDB_TABLE)

    return {"status": "Success"}

def get_user_info(event_details, group_id):
    """
    Gets user details from IAM Identity Center using user_id
    Returns username and user ID if user exists and belongs to a certain group
    Returns None and user ID otherwise
    """

    group_matches = False

    # Always adding user to a group
    user_id = event_details['requestParameters']['member']['memberId']
    _group_id = event_details['requestParameters']['groupId']
    group_matches = _group_id == group_id

    logger.info("Received new add user to group event with user_id %s", user_id)

    if not group_matches:
        logger.warning("User is not part of a requested group id %s", group_id)
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

def create_mysql_user(user_name, mysql_conn):
    """
    Creates MySQL user
    Manages MySQL connections
    Raises exception if not successful
    """

    logger.info("Creating user %s in the DB", user_name)
    db_name = os.environ.get('RDS_DB_NAME')

    create_user_q = f"CREATE USER IF NOT EXISTS '{user_name}' IDENTIFIED WITH AWSAuthenticationPlugin as 'RDS';"
    grant_q = f"GRANT INSERT, SELECT ON {db_name}.* TO '{user_name}'@'%';"

    try:
        cursor = mysql_conn.cursor()
        cursor.execute(create_user_q)
        cursor.execute(grant_q)
    except Exception as err:
        logger.error(err)
        raise Exception("Failed to execute SQL queries") from err

    logger.info("Created RDS user %s", user_name)

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
