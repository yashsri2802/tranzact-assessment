const express = require('express');
const { Queue } = require('bullmq');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(express.json({ limit: '10mb' }));

const s3 = new S3Client({ region: 'ap-south-1' });
const singleQueue = new Queue('single-pdf-queue', { connection: { host: process.env.REDIS_HOST } });
const bulkQueue = new Queue('bulk-pdf-queue', { connection: { host: process.env.REDIS_HOST } });

// Single PDF Request Handler
app.post('/api/v1/pdf/single', async (req, res) => {
  const { tenant_id, document_id, template_id, data } = req.body;
  
  const job = await singleQueue.add('render-single', {
    tenant_id,
    document_id,
    template_id,
    data
  }, { priority: 1, attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

  return res.status(202).json({
    job_id: job.id,
    status: 'QUEUED',
    status_url: `/api/v1/pdf/status/${job.id}`
  });
});

// Bulk PDF Request Handler (Point-in-Time S3 Snapshot)
app.post('/api/v1/pdf/bulk', async (req, res) => {
  const { tenant_id, bulk_job_id, documents } = req.body;
  const snapshotKey = `snapshots/${bulk_job_id}.json`;

  // 1. Upload immutable point-in-time snapshot to S3
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: snapshotKey,
    Body: JSON.stringify(documents),
    ContentType: 'application/json'
  }));

  // 2. Enqueue bulk parent job with S3 reference key
  const job = await bulkQueue.add('render-bulk', {
    tenant_id,
    bulk_job_id,
    snapshotKey,
    total_count: documents.length
  }, { priority: 2 });

  return res.status(202).json({
    bulk_job_id,
    total_documents: documents.length,
    status: 'PROCESSING',
    status_url: `/api/v1/pdf/bulk/${bulk_job_id}/status`
  });
});

app.listen(3000, () => console.log('PDF Generation Gateway listening on port 3000'));
