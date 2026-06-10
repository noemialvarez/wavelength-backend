const router = require('express').Router();
const discoveryController = require('../controllers/discoveryController');

// List/create discovery runs
router.get('/runs', discoveryController.listRuns);
router.post('/runs', discoveryController.startRun);
router.post('/scan', discoveryController.startRun);
router.get('/runs/:id', discoveryController.getRun);

// Raw signals before they become leads
router.get('/signals', discoveryController.listSignals);
router.post('/signals/:id/promote', discoveryController.promoteSignalToLead);

module.exports = router;
