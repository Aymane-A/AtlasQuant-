/**
 * services/scanJob.service.js — AtlasQuant AI
 * In-memory job tracker for long-running scans (no Redis needed).
 * Jobs auto-expire 5 minutes after creation to avoid memory leaks.
 */
const crypto = require('crypto');
const logger = require('../utils/logger');

const jobs = new Map();
const JOB_TTL_MS = 5 * 60 * 1000;

function createJob(userId = null) {
  const id = `scan_${crypto.randomBytes(16).toString('hex')}`;   // unguessable (was Date.now() + Math.random())
  jobs.set(id, {
    id,
    userId,                // owner: only this user may read the job (see getJobForUser)
    status: 'running',       // running | done | error
    cryptoCompleted: 0,
    cryptoTotal: 0,
    forexCompleted: 0,
    forexTotal: 0,
    signals: null,
    error: null,
    createdAt: Date.now(),
  });
  setTimeout(() => jobs.delete(id), JOB_TTL_MS).unref();
  return id;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
}

function getJob(id) {
  return jobs.get(id) || null;
}

/** The job, but only for its owner. Anyone else gets null (same as "not found": no enumeration). */
function getJobForUser(id, userId) {
  const job = jobs.get(id);
  if (!job || job.userId == null || String(job.userId) !== String(userId)) return null;
  return job;
}

module.exports = { createJob, updateJob, getJob, getJobForUser };