require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use('/api/config', require('./routes/config'));
app.use('/api/routes', require('./routes/routePlanning'));
app.use('/api/parse-document', require('./routes/documentParse'));

app.listen(PORT, () => console.log(`navi-toll running at http://localhost:${PORT}`));
