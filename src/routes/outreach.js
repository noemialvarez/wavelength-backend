const router = require('express').Router();
const outreachController = require('../controllers/outreachController');

// Draft email for a lead via Claude
router.post('/draft', outreachController.draftEmail);

// Approve draft and push to Lemlist
router.post('/approve/:draftId', outreachController.approveAndSend);

// List all outreach drafts
router.get('/drafts', outreachController.listDrafts);
router.get('/drafts/:id', outreachController.getDraft);
router.patch('/drafts/:id', outreachController.updateDraft);
router.delete('/drafts/:id', outreachController.deleteDraft);

// Positioning file (used as context for Claude drafts)
router.get('/positioning', outreachController.getPositioning);
router.put('/positioning', outreachController.upsertPositioning);

module.exports = router;
