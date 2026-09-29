const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the front end (index.html, app.js, styles.css, fonts/) from public/.
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Gather running at http://localhost:${PORT}`);
});
