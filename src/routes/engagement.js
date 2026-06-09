const router = require('express').Router();
const engagementController = require('../controllers/engagementController');

// Watched prospects
router.get('/prospects', engagementController.listProspects);
router.post('/prospects', engagementController.addProspect);
router.delete('/prospects/:id', engagementController.removeProspect);

// LinkedIn activity fetched via Phantombuster
router.get('/activity', engagementController.listActivity);
router.post('/activity/sync', engagementController.syncActivity);

// Drafted comments for review
router.get('/comments', engagementController.listComments);
router.post('/comments/draft', engagementController.draftComment);
router.post('/comments/:id/approve', engagementController.approveComment);
router.delete('/comments/:id', engagementController.deleteComment);

module.exports = router;
