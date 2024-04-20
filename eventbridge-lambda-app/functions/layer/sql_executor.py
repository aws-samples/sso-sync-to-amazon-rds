class SQLExecutor:
    def __init__(self, conn, engine):
        if engine == 'mysql':
            from mysql import connector
            self.executor = MySQLExecutor(conn)
        if engine == 'postgres':
            import psycopg2
            self.executor == PGExecutor(conn)
    
    def drop(self, user_name, friendly_name):
        self.executor.drop(user_name, friendly_name)

    def grant(self, user_name, role, friendly_name):
        self.executor.grant(user_name, role, friendly_name)

    def create(self, user_name, friendly_name):
        self.executor.create(user_name, friendly_name)

    def count_rows(self, user_name, friendly_name) -> int:
        return self.executor.count_rows(user_name, friendly_name)

class MySQLExecutor:
    """
    Executes MySQL queries using existing connection
    Methods support friendly_name for human readable errors
    """
    def __init__(self, conn):
        self.conn = conn

    def create(self, user_name: str, friendly_name="") -> None:
        query = f"CREATE USER IF NOT EXISTS '{user_name}' IDENTIFIED WITH AWSAuthenticationPlugin as 'RDS';"
        self.write(query, friendly_name)

    def grant(self, user_name: str, role: str, friendly_name="") -> None:
        query = f"GRANT '{role}' TO '{user_name}'@'%';"
        self.write(query, friendly_name)

    def drop(self, user_name: str, friendly_name=""):
        query = f"DROP USER IF EXISTS '{user_name}';"
        self.write(query, friendly_name)

    def write(self, query: str, friendly_name="") -> None:
        """
        Executes SQL queries
        Raises exception on errors
        Doesn't return results
        """

        try:
            cursor = self.conn.cursor()
            cursor.execute(query)
        except connector.errors.Error as err:
            raise Exception(f"Failed to execute {friendly_name} query: {err.msg}") from err
        finally:
            cursor.close()

    def count_rows(self, user_name: str, friendly_name="") -> int:
        """
        Executes SQL queries
        Raises exception on errors
        Returns number of rows
        """

        query = f"SELECT user FROM mysql.user WHERE user = '{user_name}';"

        try:
            cursor = self.conn.cursor()
            cursor.execute(query)
            cursor.fetchall()
            row_count = cursor.rowcount
        except connector.errors.Error as err:
            raise Exception(f"Failed to execute {friendly_name} query: {err.msg}") from err
        finally:
            cursor.close()

        return row_count

class PGExecutor:
    """
    Executes PostgreSQL queries using existing connection
    Methods support friendly_name for human readable errors
    """
    def __init__(self, conn):
        self.conn = conn

    def create(self, user_name: str, friendly_name="") -> None:
        query = f"CREATE USER '{user_name}';"
        self.write(query, friendly_name)
        query = f"GRANT rds_iam to '{user_name}';"
        self.write(query, friendly_name)

    def grant(self, user_name: str, role: str, friendly_name="") -> None:
        query = f"GRANT '{role}' TO '{user_name}';"
        self.write(query, friendly_name)

    def drop(self, user_name: str, friendly_name=""):
        query = f"DROP USER IF EXISTS '{user_name}';"
        self.write(query, friendly_name)

    def write(self, query: str, friendly_name="") -> None:
        """
        Executes SQL queries
        Raises exception on errors
        Doesn't return results
        """

        try:
            cursor = self.conn.cursor()
            cursor.execute(query)
        except psycopg2.OperationalError as err:
            raise Exception(f"Failed to execute {friendly_name} query: {err.msg}") from err
        finally:
            cursor.close()

    def count_rows(self, user_name: str, friendly_name="") -> int:
        """
        Executes SQL queries
        Raises exception on errors
        Returns number of rows
        """

        query = f"SELECT username FROM pg_catalog.pg_user WHERE user = '{user_name}';"

        try:
            cursor = self.conn.cursor()
            cursor.execute(query)
            cursor.fetchall()
            row_count = cursor.rowcount
        except psycopg2.OperationalError as err:
            raise Exception(f"Failed to execute {friendly_name} query: {err.msg}") from err
        finally:
            cursor.close()

        return row_count
