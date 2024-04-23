import logging
import connection_manager
from sql_executor import SQLExecutor as SE

logger = logging.getLogger()
logger.setLevel(logging.INFO)
DB_CONN = None
DB_ENGINE = None
DDB_TABLE = None

def handler(event, context):
    """Handler function, entry point for Lambda"""

    global DB_CONN
    global DB_ENGINE
    global DDB_TABLE

    details = event['detail']

    # One specific group will trigger RDS user creation
    user_id = details.get("user_id")

    # User does not exist or not in the specified group ID
    if user_id is None:
        logger.info("User doesn't belong to the specified group, skipping")
        return {"status": "Success"}

    # Inint DynamoDB table if doesn't exist
    if DDB_TABLE is None:
        DDB_TABLE = connection_manager.get_ddb_table()

    # Get username from DynamoDB
    user_name = get_user_name(user_id, DDB_TABLE)
    event_name = details.get("event_type")

    # Event type is required
    if event_name is None:
        logger.error("Event type not found")
        logger.error(details)
        raise ValueError("Event type is required but not found")

    # When removing member from a group, it's expected to be recorded in DDB
    if event_name == 'RemoveMemberFromGroup' and user_name is None:
        raise Exception("Removing member from a group, but username not found in DynamoDB")

    # Return if username mapping not in DDB
    if user_name is None:
        logger.warning("Username not found, nothing to delete")
        return {"status": "Success"}

    # Init DB connection if doesn't exist
    if DB_CONN is None:
        DB_CONN, DB_ENGINE = connection_manager.get_db_connection()

    # Init DB executor
    executor = SE(DB_CONN, DB_ENGINE)

    # Delete user from SQL DB and DDB
    delete_db_user(user_name, executor)
    delete_user_mapping(user_id, DDB_TABLE)

    return {"status": "Success"}

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
    except KeyError:
        logger.warning("User ID %s not found in DDB", user_id)
        return None
    except Exception as err:
        raise Exception("Failed to get user mapping from DDB") from err

    logger.info("Found username %s", user_name)
    return user_name

def delete_db_user(user_name, executor):
    """
    Deletes user from MySQL database if exists
    """

    logger.info("Deleting user %s from the DB", user_name)
    executor.drop(user_name, friendly_name="drop user")
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
    except Exception as err:
        raise Exception("Failed to delete user mapping from DDB") from err

    logger.info("Deleted user mapping from DynamoDB")
