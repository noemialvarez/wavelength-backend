const router = require('express').Router();
const multer = require('multer');
const outreachController = require('../controllers/outreachController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(pdf|doc|docx|txt)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, DOCX and TXT files are accepted'));
    }
  },
});

// Positioning file — upload route must come before generic /positioning routes
router.post('/positioning/upload', upload.single('file'), outreachController.uploadPositioning);
router.get('/positioning', outreachController.getPositioning);
router.put('/positioning', outreachController.upsertPositioning);

// Settings (campaign ID etc.)
router.get('/settings', outreachController.getSettings);
router.put('/settings', outreachController.upsertCampaignId);

// Draft email for a lead via Claude
router.post('/draft', outreachController.draftEmail);

// Approve draft and push to Lemlist
router.post('/approve/:draftId', outreachController.approveAndSend);

// List all outreach drafts
router.get('/drafts', outreachController.listDrafts);
router.get('/drafts/:id', outreachController.getDraft);
router.patch('/drafts/:id', outreachController.updateDraft);
router.delete('/drafts/:id', outreachController.deleteDraft);

module.exports = router;
