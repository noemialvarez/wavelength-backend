const router = require('express').Router();
const leadsController = require('../controllers/leadsController');

router.get('/', leadsController.listLeads);
router.get('/:id', leadsController.getLead);
router.post('/', leadsController.createLead);
router.patch('/:id', leadsController.updateLead);
router.delete('/:id', leadsController.deleteLead);

// Trigger Phantombuster enrichment for a lead
router.post('/:id/enrich', leadsController.enrichLead);

// Look up email via Apollo on demand
router.post('/:id/find-email', leadsController.findLeadEmail);

// Bulk import from a discovery run
router.post('/import', leadsController.importLeads);

module.exports = router;
