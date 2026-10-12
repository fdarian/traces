export const sampleStacktrace = {
  type: 'DatabaseConnectionError',
  message: 'connection refused to postgres:5432',
  stacktrace:
    'DatabaseConnectionError: connection refused to postgres:5432\n    at Pool.connect (/app/node_modules/pg/lib/pool.js:63:11)\n    at db.query (/app/src/db.ts:42:10)\n    at UserRepository.findById (/app/src/users/repository.ts:28:5)\n    at handler (/app/src/routes/users.ts:18:5)',
};
