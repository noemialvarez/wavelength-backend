const router = require('express').Router();
const leadsController = require('../controllers/leadsController');

router.get('/', leadsController.listLeads);
router.get('/:id', leadsController.getLead);
router.post('/', leadsController.createLead);
router.patch('/:id', leadsController.updateLead);
router.delete('/:id', leadsController.deleteLead);

// Find founder via Phantombuster LinkedIn Search Export
router.post('/:id/find-founder', leadsController.findFounder);

// Trigger Phantombuster enrichment for a lead
router.post('/:id/enrich', leadsController.enrichLead);

// Look up email via Apollo on demand
router.post('/:id/find-email', leadsController.findLeadEmail);

// Bulk import from a discovery run
router.post('/import', leadsController.importLeads);

// Create a lead from an Option 4 "by name" candidate and send a connection request
router.post('/by-name/connect', leadsController.connectByName);

// LinkedIn outreach message (post-connection) — draft, edit, approve & push to Lemlist
router.post('/:id/linkedin-message/draft', leadsController.draftLinkedinMessage);
router.patch('/:id/linkedin-message', leadsController.updateLinkedinMessage);
router.post('/:id/linkedin-message/approve', leadsController.approveLinkedinMessage);

// LinkedIn reminder (3-day no-reply follow-up) — draft + approve & push to Lemlist
router.post('/:id/linkedin-reminder/draft', leadsController.draftLinkedinReminder);
router.post('/:id/linkedin-reminder/approve', leadsController.approveLinkedinReminder);

module.exports = router;
