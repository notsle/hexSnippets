const sqlString = "select * from table WHERE id = @paramName;";
const sqlParams = { paramName: paramval };
BRVQuery.runPagedQuery(sqlString);
