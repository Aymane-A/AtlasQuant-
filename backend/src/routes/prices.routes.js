/**
 * routes/prices.routes.js — AtlasQuant AI
 * yahoo-finance2 + cache + in-flight dedup
 */

const express = require('express');
const YahooFinance = require('yahoo-finance2').default;
const router = express.Router();

const { rateLimiter } = require('../middleware/rateLimit.middleware');


const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey']
});


// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const DEFAULT_SYMBOLS =
  'AAPL,MSFT,NVDA,AMZN,META,GOOGL,TSLA,AMD,PLTR';


const CACHE_TTL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 300;


const ALLOWED_SYMBOLS = new Set(
  DEFAULT_SYMBOLS.split(',')
);



// ─────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────

const quoteCache = new Map();

const inFlight = new Map();


const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));



function getCached(symbol) {

  const item = quoteCache.get(symbol);

  if (!item) return null;


  if (
    Date.now() - item.cachedAt >
    CACHE_TTL_MS
  ) {

    quoteCache.delete(symbol);

    return null;
  }


  return item.data;
}



function setCache(symbol, data) {

  quoteCache.set(symbol, {

    data,

    cachedAt: Date.now()

  });

}




// ─────────────────────────────────────────────
// Normalize Yahoo response
// ─────────────────────────────────────────────

function normalize(q) {


  const change =
    q.regularMarketChangePercent ?? 0;



  return {

    symbol: q.symbol,


    name:
      q.shortName ||
      q.longName ||
      q.symbol,


    price:
      q.regularMarketPrice ?? null,


    change:
      parseFloat(change.toFixed(2)),


    volume:
      q.regularMarketVolume ?? null,


    marketCap:
      q.marketCap ?? null,


    dayHigh:
      q.regularMarketDayHigh ?? null,


    dayLow:
      q.regularMarketDayLow ?? null,


    week52High:
      q.fiftyTwoWeekHigh ?? null,


    week52Low:
      q.fiftyTwoWeekLow ?? null,


    up:
      change >= 0

  };

}



// ─────────────────────────────────────────────
// Static fallback
// ─────────────────────────────────────────────

const STATIC = {


AAPL:{
 symbol:'AAPL',
 name:'Apple Inc.',
 price:189.30,
 change:0,
 up:true
},


MSFT:{
 symbol:'MSFT',
 name:'Microsoft Corp.',
 price:415.50,
 change:0,
 up:true
},


NVDA:{
 symbol:'NVDA',
 name:'NVIDIA Corp.',
 price:875.40,
 change:0,
 up:true
},


AMZN:{
 symbol:'AMZN',
 name:'Amazon.com Inc.',
 price:183.75,
 change:0,
 up:true
},


META:{
 symbol:'META',
 name:'Meta Platforms',
 price:492.10,
 change:0,
 up:true
},


GOOGL:{
 symbol:'GOOGL',
 name:'Alphabet Inc.',
 price:175.20,
 change:0,
 up:true
},


TSLA:{
 symbol:'TSLA',
 name:'Tesla Inc.',
 price:177.90,
 change:0,
 up:false
},


AMD:{
 symbol:'AMD',
 name:'Advanced Micro Devices',
 price:155.60,
 change:0,
 up:true
},


PLTR:{
 symbol:'PLTR',
 name:'Palantir Technologies',
 price:22.80,
 change:0,
 up:true
}


};





// ─────────────────────────────────────────────
// Fetch batch optimized
// ─────────────────────────────────────────────

async function fetchBatch(symbols) {


  const key =
    [...symbols]
    .sort()
    .join(',');



  if (inFlight.has(key)) {

    return inFlight.get(key);

  }




  const promise = (async()=>{


    try {



      const results =
        await Promise.all(


          symbols.map(async symbol => {


            try {



              const q =
                await yf.quote(

                  symbol,

                  {},

                  {
                    validateResult:false
                  }

                );



              if (
                q?.regularMarketPrice !== undefined
              ) {



                const data =
                  normalize(q);



                setCache(
                  symbol,
                  data
                );



                return data;


              }



              return null;



            }

            catch(err){


              console.warn(

                `[PricesRoute] ${symbol}: ${err.message}`

              );


              return null;

            }


          })

        );



      return results.filter(Boolean);



    }

    finally {


      inFlight.delete(key);


    }



  })();




  inFlight.set(
    key,
    promise
  );



  return promise;

}







// ─────────────────────────────────────────────
// GET /api/prices/stocks
// ─────────────────────────────────────────────

router.get(
'/stocks',

rateLimiter(10),


async(req,res)=>{


try {



const rawSymbols =

(
 req.query.symbols ||
 DEFAULT_SYMBOLS
)

.replace(/[^a-zA-Z,]/g,'');




const symbols =

[
 ...new Set(

 rawSymbols
 .split(',')
 .filter(s =>
   ALLOWED_SYMBOLS.has(s)
 )

 )

];





const cached = {};
const toFetch = [];





for(const symbol of symbols){



 const hit =
 getCached(symbol);



 if(hit)

   cached[symbol] = hit;


 else

   toFetch.push(symbol);



}





const fresh = {};





if(toFetch.length){



 const batches=[];




 for(
 let i=0;
 i<toFetch.length;
 i+=BATCH_SIZE
 ){

   batches.push(
     toFetch.slice(
       i,
       i+BATCH_SIZE
     )
   );

 }



 for(
 let i=0;
 i<batches.length;
 i++
 ){


   if(i>0)

     await sleep(
       BATCH_DELAY_MS
     );



   const result =
     await fetchBatch(
       batches[i]
     );



   result.forEach(q=>{

     fresh[q.symbol]=q;

   });



 }


}






let cacheHits=0;

let staticFalls=0;






const quotes =

symbols
.map(symbol=>{


 if(fresh[symbol])

 return {

  ...fresh[symbol],

  fromCache:false

 };





 if(cached[symbol]){


 cacheHits++;


 return {

  ...cached[symbol],

  fromCache:true

 };


 }





 if(STATIC[symbol]){


 staticFalls++;



 return {

  ...STATIC[symbol],

  fromCache:false,

  isStale:true

 };


 }




 return null;


})

.filter(Boolean);






if(!quotes.length){


 return res.status(404).json({

 success:false,

 error:'No data found'

 });


}





console.log(

`[PricesRoute] ${quotes.length} quotes — ${cacheHits} cached, ${staticFalls} static`

);






res.json({


 success:true,


 data:quotes,



 meta:{


 total:quotes.length,


 cached:cacheHits,


 static:staticFalls,


 updatedAt:
 new Date().toISOString()


 }


});





}

catch(err){



console.error(

'[PricesRoute Error]',
err.message

);



res.status(500).json({

 success:false,

 error:'Failed to fetch market data'

});


}



});








// dev cache clear

if(process.env.NODE_ENV === 'development'){


router.delete(

'/stocks/cache',

(req,res)=>{


const size =
 quoteCache.size;



quoteCache.clear();



res.json({

 success:true,

 message:
 `Cleared ${size} cached quotes`

});


});


}





module.exports = router;