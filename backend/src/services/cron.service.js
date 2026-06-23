const cron = require('node-cron');
const { scanAll } = require('./signalGenerator.service');
const logger = require('../utils/logger');

const initCronJobs = () => {
    // 0 */4 * * * كتعني كل 4 سوايع
    cron.schedule('0 */4 * * *', async () => {
        logger.info('[cron] Starting scheduled market scan...');
        try {
            const results = await scanAll('4h');
            logger.info(`[cron] Scan finished. ${results.signals.length} signals generated.`);
        } catch (err) {
            logger.error(`[cron] Fatal error in scheduled scan: ${err.message}`);
        }
    });

    logger.info('[cron] AtlasQuant Background Engine initialized.');
};

module.exports = { initCronJobs };