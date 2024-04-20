import os
import logging
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
    """Handler function, entry point for Lambda"""

    logger.info("Received new event")
    event_name = function_status_code = function_error = ""

    try:
        event_name = event['requestPayload']['detail']['eventName']
        function_error = event['responseContext']['functionError']
        function_status_code = event['responseContext']['statusCode']
        error_message = event['responsePayload']['errorMessage']
    except KeyError:
        logger.error("Failed to parse the message. Sending full event details")
        logger.error(event)
        error_message = f"Failed to parse event details. The full event is provided below:\n\n{event}"
    except Exception as err:
        logger.error("Unexpected error when parsing the event")
        logger.error(err)
        raise

    subj_failure = "SSO to RDS user sync failed"
    msg = f"""\
    Lamda function failed when synchronizing SSO users to RDS.
    
    Event name: {event_name}
    Function error: {function_error}
    Status code: {function_status_code}

    {error_message}

    Check the Lambda function logs to find out more
    """

    send_sns_message(msg, subj_failure)


def send_sns_message(msg, subj):
    """
    Sends e-mail notifications if operation is failed
    SNS_ARN must be present in ENV
    Otherwise assume no notifications configured
    """

    sns_arn = os.environ.get("SNS_ARN", None)
    if sns_arn is None:
        logger.warning("No SNS ARN configured. Exiting")
        return

    client = boto3.client('sns')
    try:
        client.publish(TopicArn=sns_arn, Message=msg, Subject=subj)
    except Exception as err:
        logger.error("Failed to send SNS notification")
        logger.error(err)
        return

    logger.info("Sent SNS notification with subject: %s", subj)
