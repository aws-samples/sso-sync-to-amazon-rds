import os
import logging
import boto3
from botocore.client import Config
from mysql import connector

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def get_mysql_connection():
    """
    Creates MySQL connection using IAM credentials
    Returns mysql.connector if successful
    Raises exception if not successful
    """

    logger.info("Creating a MySQL DB connection")
    config = Config(connect_timeout=3, retries={'max_attempts': 0})
    client = boto3.client('rds', config=config)

    db_ep = os.environ.get('RDS_DB_EP')
    db_port = os.environ.get('RDS_DB_PORT', '3306')
    db_username = os.environ.get('RDS_DB_USER')
    db_name = os.environ.get('RDS_DB_NAME')

    if not all([db_ep, db_name, db_username]):
        raise Exception("DB connection details not valid. Please check env variables")

    try:
        db_pass = client.generate_db_auth_token(
            DBHostname=db_ep, Port=db_port, DBUsername=db_username
        )
    except Exception as err:
        raise Exception("Failed to retrieve DB details, please check the execution role") from err

    try:
        mysql_conn = connector.connect(
            host=db_ep,
            user=db_username,
            database=db_name,
            password=db_pass,
        )
    except Exception as err:
        logger.error(err)
        raise Exception("Failed to execute SQL queries") from err

    return mysql_conn

def get_ddb_table():
    """
    Creates DynamoDB connection 
    Returns dynamodb.Table if successful
    Raises exception if not successful
    """

    logger.info("Creating a DynamoDB connection")
    config = Config(connect_timeout=3, read_timeout=3, retries={'max_attempts': 0})
    ddb_table_name = os.environ.get('DDB_TABLE')

    if not ddb_table_name:
        raise Exception("DynamoDB table name not specified. Please check env variables")

    ddb_res = boto3.resource('dynamodb', config=config)

    try:
        ddb_table = ddb_res.Table(ddb_table_name)
    except Exception as err:
        raise Exception("Failed to get DynamoDB table") from err

    return ddb_table
