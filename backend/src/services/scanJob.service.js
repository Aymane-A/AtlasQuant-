/**
 * services/scanJob.service.js — AtlasQuant AI
 * In-memory job tracker for long-running scans (no Redis needed).
 * Jobs auto-expire 5 minutes after creation to avoid memory leaks.
 */
const logger = require('../utils/logger');

const jobs = new Map();
const JOB_TTL_MS = 5 * 60 * 1000;

function createJob() {
  const id = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  jobs.set(id, {
    id,
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

module.exports = { createJob, updateJob, getJob };