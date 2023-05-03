import os
import logging
import boto3
from botocore.client import Config
from mysql import connector

logger = logging.getLogger()
logger.setLevel(logging.INFO)
db_conn = None

def handler(event, context):
    """Handler function, entry point for Lambda"""

    # Connection can be reused by subsequent Function invocations
    global db_conn

    user_id = event['detail']['responseElements']['user']['userId']
    identitystore_id = event['detail']['requestParameters']['identityStoreId']
    logger.info("Received new event with user_id %s", user_id)

    rds_db_name = os.environ['RDS_DB_NAME']

    # One specific group will trigger RDS user creation
    group_id = os.environ['IDENTITYSTORE_GROUP_ID']

    user_name = get_user_info(user_id, group_id, identitystore_id)

    # User does not exist or not in the specified group ID
    if user_name is None:
        logger.info("Not adding user to RDS")
        return {"status": "Success"}

    logger.info("Creating user %s in the DB", user_name)

    # Reuse connection if exists
    if db_conn is None:
        db_conn = get_mysql_connection()

    if db_conn is None:
        raise Exception("Failed to connect to the DB")

    create_user_q = f"CREATE USER '{user_name}' IDENTIFIED WITH AWSAuthenticationPlugin as 'RDS';"
    grant_q = f"GRANT INSERT, SELECT ON {rds_db_name}.* TO '{user_name}'@'%';"

    cursor = db_conn.cursor()

    cursor.execute(create_user_q)
    cursor.execute(grant_q)

    logger.info("Created RDS user %s", user_name)
    return {"status": "Success"}

def get_user_info(user_id, group_id, identitystore_id):
    """
    Gets user details from IAM Identity Center using user_id
    Returns user_name if user exists and belongs to a certain group
    Returns None otherwise
    """

    config = Config(connect_timeout=3, retries={'max_attempts': 2})
    client = boto3.client('identitystore', config=config)
    user_data = client.describe_user(
        IdentityStoreId=identitystore_id,
        UserId=user_id
    )

    if not user_data:
        logger.error("Failed to get user data for user id %s", user_id)
        return None

    user_name = user_data.get('UserName', None)

    group_membership = client.is_member_in_groups(
        IdentityStoreId=identitystore_id,
        MemberId = {
            'UserId': user_id
        },
        GroupIds = [group_id]
    )

    if not group_membership:
        logger.error("Failed to get group memebership for group id %s", group_id)
        return None

    try:
        membership_ok = group_membership.get('Results', None)[0].get('MembershipExists', False)
    except IndexError:
        logger.error("Failed to get group memebership for group id %s", group_id)
        membership_ok = False

    if not membership_ok:
        logger.warning("User is not part of a requested group id %s", group_id)
        return None

    return user_name

def get_mysql_connection():
    """
    Creates MySQL connection using IAM credentials
    Returns mysql.connector if successful
    Returns None if not successful
    """

    logger.info("Creating a MySQL DB connection")
    config = Config(connect_timeout=3, retries={'max_attempts': 2})
    client = boto3.client('rds', config=config)

    db_ep = os.environ.get('RDS_DB_EP')
    db_port = os.environ.get('RDS_DB_PORT', '3306')
    db_username = os.environ.get('RDS_DB_USER')
    db_name = os.environ.get('RDS_DB_NAME')

    if not all([db_ep, db_name, db_username]):
        logger.error("DB connection details not valid. Please check env variables")
        return None

    try:
        db_pass = client.generate_db_auth_token(
            DBHostname=db_ep, Port=db_port, DBUsername=db_username
        )
    except Exception as e:
        logger.error("Failed to retrieve DB credentials, please check the execution role")
        logger.error(e)
        return None

    try:
        conn = connector.connect(
            host=db_ep,
            user=db_username,
            database=db_name,
            password=db_pass,
        )
        return conn
    except Exception as e:
        logger.error("Failed to connect to the DB")
        logger.error(e)
        return None
