/* Public exchange candles only. Never fills gaps or invents prices. */
(function (root) {
  'use strict';
  const frames = { 1000:'1s',60000:'1m',300000:'5m',900000:'15m',1800000:'30m',3600000:'1h',14400000:'4h',86400000:'1d',604800000:'1w' };
  function normalize(data, frame) {
    const k=data?.k;
    if(data?.e!=='kline'||data.s!=='SOLUSDT'||k?.s!=='SOLUSDT'||k.i!==frame) return null;
    const candle={timestamp:k.t,open:Number(k.o),high:Number(k.h),low:Number(k.l),close:Number(k.c),volume:Number(k.q)};
    if(!Number.isSafeInteger(candle.timestamp)||candle.timestamp<=0||![candle.open,candle.high,candle.low,candle.close,candle.volume].every(Number.isFinite)||Math.min(candle.open,candle.high,candle.low,candle.close)<=0||candle.volume<0||candle.high<Math.max(candle.open,candle.close)||candle.low>Math.min(candle.open,candle.close)) return null;
    return candle;
  }
  function create({onCandle,onStatus,WebSocketImpl=root.WebSocket,setTimer=setTimeout,clearTimer=clearTimeout}) {
    let socket=null,timer=null,watchdog=null,frame=null,generation=0,closed=false,attempt=0;
    function connect(ticket){
      if(closed||ticket!==generation)return;
      onStatus('connecting');
      const current=new WebSocketImpl('wss://data-stream.binance.vision/ws/solusdt@kline_'+frame);socket=current;
      const stale=()=>{if(ticket===generation){onStatus('stale');current.close();}};
      watchdog=setTimer(stale,12000);
      current.onmessage=event=>{
        if(closed||ticket!==generation)return;
        let candle;try{candle=normalize(JSON.parse(event.data),frame);}catch{return;}
        if(!candle)return;
        attempt=0;clearTimer(watchdog);watchdog=setTimer(stale,6000);
        onStatus('live');onCandle(candle,frame);
      };
      current.onerror=()=>{if(ticket===generation)onStatus('stale');};
      current.onclose=()=>{if(closed||ticket!==generation)return;clearTimer(watchdog);onStatus('stale');timer=setTimer(()=>connect(ticket),Math.min(1000*2**attempt++,10000));};
    }
    return {
      select(span){const next=frames[span];if(!next||closed||frame===next)return;generation++;clearTimer(timer);clearTimer(watchdog);socket?.close();frame=next;attempt=0;connect(generation);},
      pause(){generation++;clearTimer(timer);clearTimer(watchdog);socket?.close();socket=null;frame=null;},
      close(){closed=true;generation++;clearTimer(timer);clearTimer(watchdog);socket?.close();}
    };
  }
  const api={create,normalize};if(typeof module==='object'&&module.exports)module.exports=api;else root.MemeReferenceStream=api;
})(typeof window==='object'?window:globalThis);
