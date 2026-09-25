const router = require('express').Router();
const contactsController = require('../controllers/contactsController');

router.get('/', contactsController.listContacts);

// Public one-row CSV for the Auto Commenter Phantom to fetch — see contactsController.
router.get('/comment.csv', contactsController.commentCsv);

// Founders + executive team of a lead's company, with LinkedIn connection status
router.post('/find-team', contactsController.findTeam);
router.post('/check-connections', contactsController.checkConnections);

// "Select" a person — sends a LinkedIn connection request
router.post('/:id/select', contactsController.selectContact);
router.post('/:id/deselect', contactsController.deselectContact);

// LinkedIn Engagement: post summary and comment proposals
router.post('/:id/refresh-posts', contactsController.refreshPosts);
router.post('/:id/comments/draft', contactsController.draftComments);
router.post('/:id/comments/post', contactsController.postComment);

module.exports = router;
