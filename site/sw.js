var CACHE='cryptoyar-shell-v1';
self.addEventListener('install',function(e){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  var url;try{url=new URL(e.request.url)}catch(err){return}
  if(url.origin!==location.origin)return;
  e.respondWith(
    fetch(e.request).then(function(r){
      if(r&&r.ok){var cp=r.clone();try{caches.open(CACHE).then(function(c){c.put(e.request,cp)})}catch(err){}}
      return r;
    }).catch(function(){
      return caches.match(e.request).then(function(hit){
        if(hit)return hit;
        if(e.request.mode==='navigate')return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
