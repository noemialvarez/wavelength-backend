const router = require('express').Router();
const sequencesController = require('../controllers/sequencesController');

// Sequences synced from Lemlist
router.get('/', sequencesController.listSequences);

// All leads across all sequences (must be before /:id)
router.get('/leads', sequencesController.listAllSequenceLeads);

// Force a sync from Lemlist
router.post('/sync', sequencesController.syncFromLemlist);

router.get('/:id', sequencesController.getSequence);
router.get('/:id/leads', sequencesController.getSequenceLeads);

module.exports = router;
