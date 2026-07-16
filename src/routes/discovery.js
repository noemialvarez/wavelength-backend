const router = require('express').Router();
const discoveryController = require('../controllers/discoveryController');

// List/create discovery runs
router.get('/runs', discoveryController.listRuns);
router.post('/runs', discoveryController.startRun);
router.post('/scan', discoveryController.startRun);
router.get('/runs/:id', discoveryController.getRun);

// AI-powered company discovery from a description
router.post('/by-description', discoveryController.findByDescription);

// Structured ICP-filter company discovery (Option 1)
router.post('/by-icp', discoveryController.findByIcp);

// LinkedIn people search by name (Option 4 — "by name" discovery)
router.post('/by-name', discoveryController.findByName);

// Raw signals before they become leads
router.get('/signals', discoveryController.listSignals);
router.post('/signals/:id/promote', discoveryController.promoteSignalToLead);
router.post('/signals/:id/dismiss', discoveryController.dismissSignal);

module.exports = router;
