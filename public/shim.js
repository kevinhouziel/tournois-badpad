/* Adaptateur : fait fonctionner l'app hors de Claude avec les Functions Netlify (/api). */
(function(){
  var online=location.protocol!=='file:';
  var TK='padel-admin-token',WK='padel-who';
  /* adresse publique (spectateurs) : aucune connexion, aucun outil d'administration. L'espace pro est sur pro.tournois-badpad.fr */
  var PUB=/^(www\.)?tournois-badpad\.fr$/i.test(location.hostname);
  /* qui est connecté (juge ou administrateur) : lu tout de suite, vérifié ensuite auprès du serveur */
  (function(){try{var w=JSON.parse(localStorage.getItem(WK)||'null');var t=localStorage.getItem(TK)||'';
    if(t&&!PUB){window.padelWho=(w&&w.login)?w:{role:t.indexOf('.')>0?'judge':'admin',login:t.indexOf('.')>0?'':'admin',name:'Administrateur'}}}catch(e){}})();
  function wipeLocal(){try{Object.keys(localStorage).forEach(function(k){if(k.indexOf('tableaux-padel')===0)localStorage.removeItem(k)})}catch(e){}}
  function token(){if(PUB)return '';try{return localStorage.getItem(TK)||''}catch(e){return ''}}
  function api(path,opt){
    opt=opt||{};var h={'content-type':'application/json'};var t=token();if(t)h.Authorization='Bearer '+t;
    return fetch('/api/'+path,{method:opt.method||'GET',headers:h,body:opt.body?JSON.stringify(opt.body):undefined,cache:'no-store'})
      .then(function(r){if(!r.ok){var e=new Error('http '+r.status);e.status=r.status;throw e}return r.json()});
  }
  window.padelSendMail=function(body){return fetch('/api/send-convocations',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+token()},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return {}}).then(function(j){j.status=r.status;return j})})};
  function collection(name){
    var table=name==='public'?'pub':name;
    return {
      doc:function(id){return {set:function(d){return api('doc/'+table+'/'+id,{method:'PUT',body:{json:d.json==null?'':d.json,up:d.up||0,deleted:!!d.deleted}})}}},
      onSnapshot:function(ok,ko){
        var stopped=false,busy=false;
        function snap(list){return {docs:list.map(function(x){return {id:x.id,data:function(){return {json:x.json,up:x.up,deleted:x.deleted,owner:x.owner,ownerName:x.ownerName}}}}),metadata:{fromCache:false}}}
        function refresh(){
          if(busy)return;busy=true;
          api('list/'+table).then(function(l){if(!stopped)ok(snap(l))},function(e){if(!stopped&&ko)ko(e)}).then(function(){busy=false});
        }
        refresh();
        var iv=setInterval(refresh,8000);
        document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh()});
        return function(){stopped=true;clearInterval(iv)};
      }
    };
  }
  var admin=function(){return online?!!token():true};
  if(online)window.padelApi=api;
  window.claude={use:function(name){
    return Promise.resolve().then(function(){
      if(name==='user')return {canEdit:admin,isOwner:admin,can:admin};
      if(name==='db')return online?{collection:collection}:null;
      if(name==='downloads')return {save:function(o){
        var blob=o.data instanceof Blob?o.data:new Blob([o.data]);var a=document.createElement('a');
        a.href=URL.createObjectURL(blob);a.download=o.filename||'fichier';document.body.appendChild(a);a.click();
        setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},500);return Promise.resolve()}};
      return null;
    });
  }};
  if(!online)return;

  /* attribuer un tournoi à un juge (administrateur) */
  window.padelAssign=function(tid){
    api('users').then(function(us){
      var bg=document.createElement('div');bg.id='adm-bg';
      function esc(t){return String(t).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
      var opts='<option value="admin">Administrateur (moi)</option>'+us.map(function(u){return '<option value="'+esc(u.login)+'">'+esc(u.name)+' ('+esc(u.login)+')</option>'}).join('');
      bg.innerHTML='<div id="adm-box"><b>Attribuer ce tournoi à</b><select id="as-o" style="padding:8px;border:1px solid #ccc;border-radius:6px">'+opts+'</select><small style="color:#777">Le juge choisi pourra le modifier et le supprimer. Les autres le verront en lecture seule.</small><div id="adm-err"></div><button id="as-s" type="button">Attribuer</button><button type="button" id="adm-x" style="background:#999">Annuler</button></div>';
      document.body.appendChild(bg);
      bg.querySelector('#adm-x').onclick=function(){bg.remove()};
      bg.querySelector('#as-s').onclick=function(){api('owner/'+tid,{method:'POST',body:{owner:bg.querySelector('#as-o').value}}).then(function(){location.reload()},function(){bg.querySelector('#adm-err').textContent='Erreur, réessaie.'})};
    });
  };
  function openJudges(){
    var bg=document.createElement('div');bg.id='adm-bg';
    bg.innerHTML='<div id="adm-box" style="width:min(460px,94vw);max-height:90vh;overflow:auto"><b>Juges-arbitres</b><div id="jl" style="display:grid;gap:6px"></div><hr style="width:100%;border:0;border-top:1px solid #ddd"><b style="font-size:13px">Ajouter ou modifier un juge</b><input id="jn" placeholder="Nom affiché (ex : Marc Dupont)" maxlength="40"><input id="ji" placeholder="Identifiant (minuscules, sans espace)" maxlength="24" autocapitalize="none"><input id="jp" placeholder="Mot de passe (6 caractères minimum)"><div id="adm-err"></div><button id="js" type="button">Enregistrer</button><button type="button" id="adm-x" style="background:#999">Fermer</button></div>';
    document.body.appendChild(bg);
    var err=bg.querySelector('#adm-err');
    function esc(t){return String(t).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
    function load(){api('users').then(function(us){
      bg.querySelector('#jl').innerHTML=us.length?us.map(function(u){return '<div style="display:flex;gap:6px;align-items:center;border:1px solid #e3d9c8;border-radius:6px;padding:6px 8px"><span style="flex:1"><b>'+esc(u.name)+'</b><br><small style="color:#777">'+esc(u.login)+'</small></span><button class="jd" data-l="'+esc(u.login)+'" data-n="'+esc(u.name)+'" style="background:#fff;color:#9b1d36;border:1px solid #9b1d36;padding:4px 8px">Modifier</button><button class="jx" data-l="'+esc(u.login)+'" style="background:#fff;color:#b00;border:1px solid #b00;padding:4px 8px">Retirer</button></div>'}).join(''):'<small style="color:#777">Aucun juge pour l\'instant.</small>'},function(){bg.querySelector('#jl').textContent='Erreur de chargement.'})}
    load();
    bg.querySelector('#adm-x').onclick=function(){bg.remove()};
    bg.onclick=function(e){
      var d=e.target.closest('.jd'),x=e.target.closest('.jx');
      if(d){bg.querySelector('#jn').value=d.dataset.n;bg.querySelector('#ji').value=d.dataset.l;bg.querySelector('#jp').value='';bg.querySelector('#jp').placeholder='Nouveau mot de passe (vide = inchangé)';err.textContent=''}
      if(x&&confirm('Retirer ce juge ? Ses tournois restent, mais seul toi pourras les modifier.'))api('users/'+x.dataset.l,{method:'DELETE'}).then(load);
    };
    bg.querySelector('#js').onclick=function(){
      var n=bg.querySelector('#jn').value.trim(),i=bg.querySelector('#ji').value.trim().toLowerCase(),p=bg.querySelector('#jp').value.trim();
      if(!n||!/^[a-z0-9_-]{2,24}$/.test(i)||i==='admin'){err.textContent='Nom et identifiant (2 à 24 caractères : lettres minuscules, chiffres, - ou _) obligatoires.';return}
      var body={name:n};if(p)body.password=p;
      api('users/'+i,{method:'PUT',body:body}).then(function(){err.textContent='';bg.querySelector('#jn').value='';bg.querySelector('#ji').value='';bg.querySelector('#jp').value='';load()},function(e){err.textContent=e&&e.status===400?'Mot de passe de 6 caractères minimum (obligatoire pour un nouveau juge).':'Erreur '+(e&&e.status||'réseau')});
    };
  }

  document.addEventListener('DOMContentLoaded',function(){
    if(PUB)return;
    var st=document.createElement('style');
    st.textContent='#adm-bar{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px 0}.adm-l{font:600 13px system-ui;color:#9b1d36;background:#fff;border:1px solid #9b1d36;border-radius:6px;padding:5px 10px;cursor:pointer}.adm-l:hover{background:#9b1d36;color:#fff}'+
    '#adm-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100;display:flex;align-items:center;justify-content:center}#adm-box{background:#fff;border-radius:10px;padding:18px;width:min(320px,90vw);font:14px system-ui;display:grid;gap:10px}#adm-box input{padding:8px;border:1px solid #ccc;border-radius:6px;font:inherit}#adm-box button{padding:8px;border-radius:6px;border:0;background:#9b1d36;color:#fff;font:inherit;cursor:pointer}#adm-err{color:#b00;font-size:12px;min-height:1em}';
    document.head.appendChild(st);
    var bar=document.createElement('div');bar.id='adm-bar';document.body.insertBefore(bar,document.body.firstChild);
    var who=window.padelWho,isAdm=!!who&&who.role==='admin';
    var b=document.createElement('button');b.className='adm-l';b.textContent=token()?'Déconnexion'+(who&&who.role==='judge'?' ('+who.name+')':' admin'):'Connexion juge-arbitre';bar.appendChild(b);
    if(token()){
      api('me').then(function(r){try{localStorage.setItem(WK,JSON.stringify({role:r.role,login:r.login,name:r.name}))}catch(e){}window.padelWho=r},function(e){if(e&&e.status===401){try{localStorage.removeItem(TK);localStorage.removeItem(WK)}catch(x){}wipeLocal();location.reload()}});
    }
    if(isAdm){
      var jb=document.createElement('button');jb.className='adm-l';jb.textContent='Juges-arbitres';bar.insertBefore(jb,b);
      jb.onclick=openJudges;
    }
    if(token()){
      var im=document.createElement('button');im.className='adm-l';im.textContent='Importer des tournois';bar.insertBefore(im,b);
      var fi=document.createElement('input');fi.type='file';fi.accept='.json';fi.hidden=true;document.body.appendChild(fi);
      im.onclick=function(){fi.click()};
      fi.onchange=function(){var f=fi.files[0];if(!f)return;f.text().then(function(t){
        var rows=JSON.parse(t);return rows.reduce(function(p,r){return p.then(function(){return api('doc/'+r.table+'/'+r.id,{method:'PUT',body:{json:r.json,up:r.up,deleted:false}})})},Promise.resolve()).then(function(){location.reload()})
      }).catch(function(){alert("Fichier d'import invalide.")})};
    }
    b.onclick=function(){
      if(token()){try{localStorage.removeItem(TK);localStorage.removeItem(WK)}catch(e){}wipeLocal();location.reload();return}
      var bg=document.createElement('div');bg.id='adm-bg';
      bg.innerHTML='<form id="adm-box"><b>Connexion</b><input id="adm-l" placeholder="Identifiant (vide = administrateur)" autocomplete="username" autocapitalize="none"><input type="password" id="adm-p" placeholder="Mot de passe" autocomplete="current-password" required><div id="adm-err"></div><button type="submit">Se connecter</button><button type="button" id="adm-x" style="background:#999">Annuler</button></form>';
      document.body.appendChild(bg);bg.querySelector('#adm-l').focus();
      bg.querySelector('#adm-x').onclick=function(){bg.remove()};
      bg.querySelector('#adm-box').onsubmit=function(e){e.preventDefault();
        api('login',{method:'POST',body:{login:bg.querySelector('#adm-l').value,password:bg.querySelector('#adm-p').value}}).then(function(r){
          wipeLocal();try{localStorage.setItem(TK,r.token);localStorage.setItem(WK,JSON.stringify({role:r.role,login:r.login,name:r.name}))}catch(e){}location.reload()
        },function(e){var m=e&&e.status===401?'Identifiant ou mot de passe incorrect.':e&&e.status===500?"Le mot de passe ADMIN_PASSWORD n'est pas reçu par le site : vérifie la variable (scopes : Functions) puis relance un déploiement.":e&&e.status===404?"API introuvable : le dossier netlify n'est pas déployé.":'Erreur '+(e&&e.status||'réseau');bg.querySelector('#adm-err').textContent=m})};
    };
  });
})();
