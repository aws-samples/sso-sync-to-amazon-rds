import os
import logging
import boto3
from botocore.client import Config

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def get_db_connection():
    """
    Creates DB connection using IAM credentials
    Returns connector if successful
    Raises exception if not successful
    """

    logger.info("Creating a DB connection")
    config = Config(connect_timeout=3, retries={'max_attempts': 0})
    client = boto3.client('rds', config=config)

    db_ep = os.environ.get('RDS_DB_EP')
    db_port = os.environ.get('RDS_DB_PORT', '3306')
    db_username = os.environ.get('RDS_DB_USER')
    db_engine = os.environ.get('RDS_DB_ENGINE', 'mysql') # mysql or postgres

    if not all([db_ep, db_username]):
        raise Exception("DB connection details not valid. Please check env variables")
    
    if 'mysql' in db_engine:
        db_engine = 'mysql'
    elif 'postgres' in db_engine:
        db_engine = 'postgres'
    else:
        raise Exception(f"DB engine {db_engine} is not supported")

    try:
        db_pass = client.generate_db_auth_token(
            DBHostname=db_ep, Port=db_port, DBUsername=db_username
        )
    except Exception as err:
        raise Exception("Failed to retrieve DB details, please check the execution role") from err

    if db_engine == 'mysql':
        from mysql import connector
    if db_engine == 'postgres':
        import psycopg2 as connector

    try:
        db_conn = connector.connect(
            host=db_ep,
            user=db_username,
            password=db_pass,
            port=db_port,
            auth_plugin='mysql_clear_password'
        )
    except Exception as err:
        logger.error(err)
        raise Exception("Failed to connect to the db") from err

    return (db_conn, db_engine)

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
