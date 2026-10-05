// HttpError for rule violations the API checks itself, and an Express error
// handler that also turns MySQL constraint/trigger errors into clear 4xx replies.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MYSQL_ERRORS = {
  ER_SIGNAL_EXCEPTION: 409,            // a trigger in triggers.sql raised "BRxx: ..."
  ER_DUP_ENTRY: 409,                   // UNIQUE constraint
  ER_CHECK_CONSTRAINT_VIOLATED: 400,   // CHECK constraint
  ER_NO_REFERENCED_ROW_2: 400,         // foreign key points at nothing
  ER_ROW_IS_REFERENCED_2: 409,         // row still used by another table
  ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: 400,
  WARN_DATA_TRUNCATED: 400,            // value not in an ENUM
  ER_BAD_NULL_ERROR: 400
};

function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.code && MYSQL_ERRORS[err.code]) return res.status(MYSQL_ERRORS[err.code]).json({ error: err.sqlMessage || err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
}

module.exports = { HttpError, errorHandler };
