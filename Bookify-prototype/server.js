const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// JSON API backed by MySQL (see src/ and db/).
app.use('/api', require('./src/api'));

// Serve the front end (index.html, app.js, styles.css, fonts/) from public/.
app.use(express.static(path.join(__dirname, 'public')));

// Run a server when started with `node server.js`; when a serverless host such
// as Vercel imports this file instead, it uses the exported app.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Bookify running at http://localhost:${PORT}  (API at /api)`);
  });
}

module.exports = app;
