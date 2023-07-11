import os
import logging
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
    user_id = get_user_id(event['detail'])

    # User does not exist or not in the specified group ID
    if user_id is None:
        logger.info("User doesn't belong to the specified group, skipping")
        return {"status": "Success"}

    # Inint DynamoDB table if doesn't exist
    if ddb_table is None:
        ddb_table = connection_manager.get_ddb_table()

    # Get username from DynamoDB
    user_name = get_user_name(user_id, ddb_table)

    # Return if username mapping not in DDB
    if not user_name:
        logger.warning("Username not found, nothing to delete")
        return {"status": "Success"}

    # Init MySQL connection if doesn't exist
    if mysql_conn is None:
        mysql_conn = connection_manager.get_mysql_connection()

    # Delete user from MySQL and DDB
    delete_mysql_user(user_name, mysql_conn)
    delete_user_mapping(user_id, ddb_table)

    return {"status": "Success"}

def get_user_id(event_details):
    """
    Parses the event details
    Returns user_id if the group is unknown or the user belongs to the configured group
    Returns None if user doesn't belong to the configured group (no need to delete)
    """

    event_type = event_details['eventName']
    check_group = True
    group_matches = True

    group_id = os.environ.get('IDENTITYSTORE_GROUP_ID')

    # Can't check group membership if group ID is not specified
    if group_id is None:
        logger.warning("Group ID is not specified in env, skipping group checks")
        check_group = False

    # Removing user from a group
    if event_type == 'RemoveMemberFromGroup' and check_group:
        user_id = event_details['requestParameters']['memberId']
        event_name = "remove user from group"

        # Check group membership when group ID is configured
        if check_group:
            _group_id = event_details['requestParameters']['groupId']
            group_matches = _group_id == group_id
    # Deleting user
    else:
        user_id = event_details['requestParameters']['userId']
        event_name = "delete user"

    logger.info("Received new %s event with user_id %s", event_name, user_id)

    if not group_matches:
        logger.info("Configured group doesn't match")
        return None

    logger.info("Succesfully parsed user ID")
    return user_id

def get_user_name(user_id, ddb_table):
    """
    Returns username from DynamoDB table if exists
    Returns None otherwise
    Raises exceptions on errors
    """

    logger.info("Retrieving user ID %s from DynamoDB", user_id)

    try:
        resp = ddb_table.get_item(
            Key={
                'userID': user_id
            }
        )
        data = resp['Item']
        logger.info(data)
        user_name = data['username']
    except KeyError as e:
        logger.warning("User ID %s not found in DDB", user_id)
        return None
    except Exception as e:
        raise Exception("Failed to get user mapping from DDB") from e

    logger.info("Found username %s", user_name)
    return user_name

def delete_mysql_user(user_name, mysql_conn):
    """
    Deletes user from MySQL database if exists
    Raises exceptions on errors
    """

    logger.info("Deleting user %s from the DB", user_name)
    drop_user_q = f"DROP USER IF EXISTS '{user_name}';"

    try:
        cursor = mysql_conn.cursor()
        cursor.execute(drop_user_q)
    except Exception as e:
        logger.error(e)
        raise Exception("Failed to execute SQL queries") from e

    logger.info("Deleted RDS user %s", user_name)

def delete_user_mapping(user_id, ddb_table):
    """
    Deletes user ID to username mapping from DynamoDB
    Raises exceptions on errors
    """

    logger.info("Retrieving user ID %s from DynamoDB", user_id)

    try:
        ddb_table.delete_item(
            Key={
                'userID': user_id
            }
        )
    except Exception as e:
        raise Exception("Failed to delete user mapping from DDB") from e

    logger.info("Deleted user mapping from DynamoDB")
