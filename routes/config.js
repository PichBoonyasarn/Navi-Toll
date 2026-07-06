const express = require('express');
const router = express.Router();

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';
const COMPANY_ADDRESS  = process.env.COMPANY_ADDRESS  || '';

router.get('/', (req, res) => {
  res.json({ googleMapsKey: GOOGLE_MAPS_KEY, companyAddress: COMPANY_ADDRESS });
});

module.exports = router;
