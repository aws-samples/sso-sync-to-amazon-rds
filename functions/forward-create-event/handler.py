import os
import logging
import json
import boto3


logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
    """Handler function, entry point for Lambda"""

    group_ids = json.loads(os.environ.get('IDENTITYSTORE_GROUP_IDS'))
    event_group_id = event['detail']['requestParameters']['groupId']
    user_name, user_id = get_user_info(event['detail'])
    role_name = group_ids[event_group_id]

    target_bus = os.environ.get('DEST_BUS_NAME')

    # Target bus is required in env
    if target_bus is None:
        logger.info("Missing target event bus in ENV")
        raise ValueError("Target bus not specified")

    # User does not exist or not in the specified group ID
    if user_name is None:
        logger.info("Not adding user to RDS")
        return {"status": "Success"}

    modified_event = {
        "user_name": user_name,
        "user_id": user_id,
        "role_name": role_name,
        "group_id": event_group_id,
        "event_type": event['detail']['eventName']
    }

    # Send event to the target bus
    publish_event(modified_event, target_bus)
    logger.info("Forwarded create event for user %s", user_name)

    return {"status": "Success"}

def publish_event(modified_event, bus_name):
    """
    Forwards event to the specified event bus
    """
    event_client = boto3.client('events')
    logger.info("Forwarding user details to the event bus")
    event_client.put_events(
            Entries=[
                {
                    'Source': 'Lambda function: forward-create-event',
                    'DetailType': modified_event['event_type'],
                    'Detail': json.dumps(modified_event),
                    'EventBusName': bus_name
                },
            ]
        )

def get_user_info(event_details):
    """
    Gets user details from IAM Identity Center using user_id
    Returns username and user ID if user exists and belongs to a certain group
    Returns None and user ID otherwise
    """

    # Always adding user to a group (even on user creation)
    user_id = event_details['requestParameters']['member']['memberId']

    logger.info("Received new add user to group event with user_id %s", user_id)

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
