const TradeRepository = require('../repositories/trade.repository');
const logger = require('../utils/logger');

const TradeService = {
  
    async openPaperTrade(userId, signalData) {
        if (signalData.confidence < 70) {
            logger.warn(`[TradeService] Low confidence (${signalData.confidence}%), trade skipped.`);
            return null;
        }

        const trade = await TradeRepository.create({
            userId,
            symbol: signalData.rawSymbol,
            side: signalData.signal,
            entryPrice: signalData.entry,
            quantity: 1 
        });
        
        logger.info(`[TradeService] Trade opened: ${trade.symbol} at ${trade.entry_price}`);
        return trade;
    },

   
    async checkAndCloseTrades(currentPrices) {
        
    }
};

module.exports = TradeService;