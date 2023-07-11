import os
import logging
import boto3
from botocore.client import Config
from lambda_utils import connection_manager

logger = logging.getLogger()
logger.setLevel(logging.INFO)
mysql_conn = None
ddb_table = None

def handler(event, context):
    """Handler function, entry point for Lambda"""

    global mysql_conn
    global ddb_table

    # One specific group will trigger RDS user creation
    group_id = os.environ['IDENTITYSTORE_GROUP_ID']
    user_name, user_id = get_user_info(event['detail'], group_id)

    # User does not exist or not in the specified group ID
    if user_name is None:
        logger.info("Not adding user to RDS")
        return {"status": "Success"}

    # Init DynamoDB table if doesn't exist
    if ddb_table is None:
        ddb_table = connection_manager.get_ddb_table()

    # Init MySQL connection if doesn't exist
    if mysql_conn is None:
        mysql_conn = connection_manager.get_mysql_connection()

    # Create user in MySQL db and user mapping in DynamoDB
    create_mysql_user(user_name, mysql_conn=mysql_conn)
    create_user_mapping(user_id=user_id, user_name=user_name, ddb_table=ddb_table)

    return {"status": "Success"}

def get_user_info(event_details, group_id):
    """
    Gets user details from IAM Identity Center using user_id
    Returns username and user ID if user exists and belongs to a certain group
    Returns None and user ID otherwise
    """

    event_type = event_details['eventName']
    skip_membership_check = False
    group_matches = False

    # Adding user to a group
    if event_type == 'AddMemberToGroup':
        user_id = event_details['requestParameters']['member']['memberId']
        _group_id = event_details['requestParameters']['groupId']
        event_name = "add user to group"
        skip_membership_check = True
        group_matches = _group_id == group_id
    # Creating a new user (group is none in this case)
    else:
        user_id = event_details['responseElements']['user']['userId']
        event_name = "create user"

    logger.info("Received new %s event with user_id %s", event_name, user_id)

    if skip_membership_check and not group_matches:
        logger.warning("User is not part of a requested group id %s", group_id)
        return None, user_id

    identitystore_id = event_details['requestParameters']['identityStoreId']

    config = Config(connect_timeout=3, retries={'max_attempts': 2})
    client = boto3.client('identitystore', config=config)
    user_data = client.describe_user(
        IdentityStoreId=identitystore_id,
        UserId=user_id
    )

    if not user_data:
        logger.error("Failed to get user data for user id %s", user_id)
        return None, user_id

    user_name = user_data.get('UserName', None)

    if skip_membership_check:
        return user_name, user_id

    group_membership = client.is_member_in_groups(
        IdentityStoreId=identitystore_id,
        MemberId = {
            'UserId': user_id
        },
        GroupIds = [group_id]
    )

    if not group_membership:
        logger.error("Failed to get group memebership for group id %s", group_id)
        return None, user_id

    try:
        membership_ok = group_membership.get('Results', None)[0].get('MembershipExists', False)
    except IndexError:
        logger.error("Failed to get group memebership for group id %s", group_id)
        membership_ok = False

    if not membership_ok:
        logger.warning("User is not part of a requested group id %s", group_id)
        return None, user_id

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
    except Exception as e:
        logger.error(e)
        raise Exception("Failed to execute SQL queries") from e

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
    except Exception as e:
        raise Exception("Failed to save user mapping to DDB") from e

    logger.info("Successfully created user ID to username mapping")
