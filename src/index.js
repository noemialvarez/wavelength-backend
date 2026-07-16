const app = require('./app');
const cronService = require('./services/cronService');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Wavelength API running on port ${PORT}`));
cronService.start();
