function logError(context, error) {
  console.error(`\n[ERROR] ${context}`);
  if (error?.message) console.error('  message:', error.message);
  if (error?.details) console.error('  details:', error.details);
  if (error?.hint)    console.error('  hint:   ', error.hint);
  if (error?.code)    console.error('  code:   ', error.code);
  if (error?.stack)   console.error('  stack:\n', error.stack);
  if (error && !error.stack) console.error('  raw:', error);
}

module.exports = logError;
