from mysql import connector


class MySQLExecutor:
    """
    Executes MySQL queries using existing connection
    Methods support friendly_name for human readable errors
    """
    def __init__(self, conn):
        self.conn = conn

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

    def count_rows(self, query: str, friendly_name="") -> int:
        """
        Executes SQL queries
        Raises exception on errors
        Returns number of rows
        """

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
