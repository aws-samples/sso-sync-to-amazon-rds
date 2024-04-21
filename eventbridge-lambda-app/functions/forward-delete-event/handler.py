import os
import logging
import json
import boto3


logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
    """Handler function, entry point for Lambda"""

    target_bus = os.environ.get('DEST_BUS_NAME')

    # Target bus is required in env
    if target_bus is None:
        logger.info("Missing target event bus in ENV")
        raise ValueError("Target bus not specified")

    # One specific group will trigger RDS user creation
    user_id = get_user_id(event['detail'])

    # User does not exist or not in the specified group ID
    if user_id is None:
        logger.info("User doesn't belong to the specified group, skipping")
        return {"status": "Success"}

    modified_event = {
        "user_id": user_id,
        "event_type": event['detail']['eventName']
    }

    # Send the event to the target bus
    publish_event(modified_event, target_bus)
    logger.info("Forwarded delete event for user id %s", user_id)

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

    group_ids = json.loads(os.environ.get('IDENTITYSTORE_GROUP_IDS'))

    # Can't check group membership if group ID is not specified
    if group_ids is None:
        logger.warning("Group ID is not specified in env, skipping group checks")
        check_group = False

    # Removing user from a group
    if event_type == 'RemoveMemberFromGroup' and check_group:
        user_id = event_details['requestParameters']['memberId']
        event_name = "remove user from group"

        # Check group membership when group ID is configured
        if check_group:
            _group_id = event_details['requestParameters']['groupId']
            group_matches = _group_id in group_ids.keys()
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

def publish_event(modified_event, bus_name):
    """
    Forwards event to the specified event bus
    """
    event_client = boto3.client('events')
    logger.info("Forwarding user details to the event bus")
    event_client.put_events(
            Entries=[
                {
                    'Source': modified_event['event_type'],
                    'DetailType': 'New SSO to RDS delete event recieved',
                    'Detail': json.dumps(modified_event),
                    'EventBusName': bus_name
                },
            ]
        )
