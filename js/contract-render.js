/* ══════════════════════════════════════════════════════════
   三份契約的唯一真實來源。
   後台預覽、房東/房客簽署頁、列印 PDF 全部呼叫這個檔案，
   所以條文只會存在一份，不可能出現「預覽跟實際簽的不一樣」。

   kind：
     sub = 住宅轉租契約（業者 ↔ 房客），依「住宅轉租定型化契約
           應記載及不得記載事項」113/11/21 修正版
     bz  = 住宅包租契約（房東 ↔ 包租業），依「住宅包租契約
           應約定及不得約定事項」108/2/23 訂定、108/6/1 生效
     wg  = 租賃住宅委託管理契約（房東 ↔ 代管業），依「租賃住宅
           委託管理定型化契約應記載及不得記載事項」
           108/9/5 公告、108/12/1 生效

   資料形狀刻意只有一種（見 blankData()）：共用的主體／標的資料
   放在最上層，三份契約各自的條件放在 d.sub / d.bz / d.wg。
   renderMain() 是最早寫的，它直接讀 d.term / d.rent，所以
   dispatcher 會先把 d.sub 攤平上來再呼叫它。
   ══════════════════════════════════════════════════════════ */
(function(root){
'use strict';

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function v(x,w){
  const s=(x==null||x==='')?'　'.repeat(w||4):String(x);
  return '<span class="v">'+esc(s)+'</span>';
}
function cb(on,label){
  return '<span class="cb '+(on?'on':'off')+'">'+(on?'☑':'☐')+'</span>'+(label?esc(label):'');
}
/* 空值要回空字串而不是 0。空白模板印出「0 元整」會讓人以為真的
   約定了零元，留白格才是正確的待填狀態。 */
function money(n){
  if(n===''||n==null||isNaN(Number(n)))return '';
  return Number(n).toLocaleString('en-US');
}
function roc(iso){
  if(!iso)return {y:'',m:'',d:''};
  const p=String(iso).split('-');
  return {y:String(+p[0]-1911),m:String(+p[1]),d:String(+p[2])};
}
function rocStr(iso){const r=roc(iso);return r.y?('民國'+r.y+'年'+r.m+'月'+r.d+'日'):'民國　年　月　日';}
/* 含起訖日。母法「租賃期間不得少於三十日」是拿這個數字比的，
   用差值會把剛好三十日的合法租約誤判成二十九日。 */
function days(a,b){
  if(!a||!b)return 0;
  return Math.round((new Date(b)-new Date(a))/86400000)+1;
}
/* 身分證號只遮，不假裝加密。真正的保護在 RLS 與存取稽核。 */
function maskId(s){
  s=String(s||'');
  return s.length>=10?(s.slice(0,2)+'****'+s.slice(6)):s;
}
/* 地址組字串 */
function addrOf(p){
  return [p.city,p.dist,p.road,p.sec?p.sec+'段':'',p.lane?p.lane+'巷':'',
          p.alley?p.alley+'弄':'',p.no?p.no+'號':'',p.floor?p.floor+'樓':'',
          p.floorSub?'之'+p.floorSub:''].filter(Boolean).join('');
}

/* ══════════════════════════════════════════════════════════
   租賃住宅標示＋範圍。包租契約第一點與委管契約第二點的文字
   幾乎相同，差別只在「租賃範圍／委託管理範圍」與附件名稱，
   所以共用一個函數，避免兩邊條文日後不同步。
   ══════════════════════════════════════════════════════════ */
function propBlock(d,mode){
  const p=d.prop,s=(mode==='bz'?d.bz:d.wg).scope;
  const rangeLabel=(mode==='bz'?'租賃範圍':'委託管理範圍');
  const annexName=(mode==='bz'?'租賃標的現況確認書（如附件一）':'委託管理標的現況確認書（如附件）');
  let h='';
  h+='<p>（一）租賃住宅標示：</p>'+
     '<p class="ind1">1. 門牌'+v(p.city,2)+'縣（市）'+v(p.dist,2)+'鄉（鎮、市、區）'+
       v(p.road,3)+'街（路）'+v(p.sec,1)+'段'+v(p.lane,1)+'巷'+v(p.alley,1)+'弄'+
       v(p.no,1)+'號'+v(p.floor,1)+'樓之'+v(p.floorSub,1)+
       '（基地坐落'+v(p.landSec,2)+'段'+v(p.landSubSec,2)+'小段'+v(p.landNo,2)+'地號）。'+
       '無門牌者，其房屋稅籍編號：'+v(p.taxNo,6)+'或其位置略圖。</p>'+
     '<p class="ind1">2. 專有部分建號'+v(p.bldgNo,2)+'，權利範圍'+v(p.right,2)+
       '，面積共計'+v(p.areaTotal,2)+'平方公尺。</p>'+
     '<p class="ind2">（1）主建物面積：'+
       p.mainFloors.map(x=>v(x.f,1)+'層'+v(x.a,2)+'平方公尺').join('，')+
       '，共計'+v(p.mainTotal,2)+'平方公尺，用途'+v(p.mainUse,2)+'。</p>'+
     '<p class="ind2">（2）附屬建物用途'+v(p.annexUse,2)+'，面積'+v(p.annexArea,2)+'平方公尺。</p>'+
     '<p class="ind1">3. 共有部分建號'+v(p.commonBldgNo,2)+'，權利範圍'+v(p.commonRight,2)+
       '，持分面積'+v(p.commonArea,2)+'平方公尺。</p>'+
     '<p class="ind1">4. 車位：'+cb(p.hasParking,'有')+
       '（汽車停車位'+v(p.carPark,1)+'個、機車停車位'+v(p.motoPark,1)+'個）'+
       cb(!p.hasParking,'無')+'。</p>'+
     '<p class="ind1">5. '+cb(p.hasOtherRight,'有')+cb(!p.hasOtherRight,'無')+
       '設定他項權利，若有，權利種類：'+v(p.otherRightType,4)+'。</p>'+
     '<p class="ind1">6. '+cb(p.hasSeizure,'有')+cb(!p.hasSeizure,'無')+'查封登記。</p>';
  h+='<p>（二）'+rangeLabel+'：</p>'+
     '<p class="ind1">1. 租賃住宅'+cb(s.whole,'全部')+cb(!s.whole,'部分')+
       '：第'+v(s.floor,1)+'層'+cb(!s.whole,'房間')+v(s.roomCount,1)+'間'+
       cb(false,'第')+v(s.roomNo,2)+'室，面積'+v(s.area,2)+'平方公尺'+
       (mode==='bz'?'（如「租賃住宅位置格局示意圖」標註之租賃範圍）':'')+'。</p>'+
     '<p class="ind1">2. 車位（如無則免填）：'+
       cb(false,'汽車停車位')+cb(false,'機車停車位')+'　使用時間：'+
       cb(false,'全日')+cb(false,'日間')+cb(false,'夜間')+cb(false,'其他')+'。</p>'+
     '<p class="ind1">3. 租賃附屬設備：'+cb(s.hasFurniture,'有')+cb(!s.hasFurniture,'無')+
       '附屬設備，若有，除另有附屬設備清單外，詳如後附'+annexName+'。</p>'+
     '<p class="ind1">4. 其他：'+v('',6)+'。</p>';
  return h;
}

/* ══════════════════════════════════════════════════════════
   住宅包租契約書（依內政部應約定事項二十三點）
   ══════════════════════════════════════════════════════════ */
function renderBZ(d){
  const b=d.bz,t=b.term,rn=b.rent,dp=b.deposit,f=b.fees;
  const termDays=days(t.from,t.to);
  let h='<div class="paper">';

  h+='<h1 class="doc-title">住 宅 包 租 契 約 書</h1>'+
     '<div class="doc-sub">依內政部「住宅包租契約應約定及不得約定事項」'+
     '（中華民國108年2月23日內授中辦地字第1080260693號令，108年6月1日生效）製作</div>'+
     '<div class="doc-no">契約編號：'+v(d.no)+'</div>';

  h+='<p style="margin:0 0 12px">立契約書人　出租人'+v(d.owner.name)+
     '（以下稱出租人）、包租業'+v(d.biz.name)+
     '（以下稱包租業），茲就租賃住宅之包租事宜，約定條款如下：</p>';

  /* 一 租賃標的 */
  h+='<div class="art"><div class="art-h">第一點　租賃標的</div><div class="art-b">'+
     propBlock(d,'bz')+'</div></div>';

  /* 二 租賃期間 */
  h+='<div class="art"><div class="art-h">第二點　租賃期間</div><div class="art-b">'+
     '<p>租賃期間自'+v(rocStr(t.from))+'起至'+v(rocStr(t.to))+'止'+
     '（共'+v(termDays,3)+'日）。</p>'+
     '<p style="color:#666;font-size:11.5px">（依規定租賃期間不得少於三十日。）</p>'+
     '</div></div>';

  /* 三 租金約定及支付 */
  h+='<div class="art"><div class="art-h">第三點　租金約定及支付</div><div class="art-b">'+
     '<p>包租業每月租金為新臺幣（下同）'+v(money(rn.monthly))+'元整，'+
     '每期應繳納'+v(rn.periods,1)+'個月租金，並於每'+
     cb(rn.payUnit==='月','月')+cb(rn.payUnit==='期','期')+v(rn.payDay,1)+
     '日前支付，不得藉任何理由拖延或拒絕。</p>'+
     '<p>租金支付方式：'+cb(rn.method==='cash','現金繳付')+'　'+
     cb(rn.method==='transfer','轉帳繳付')+'：金融機構：'+v(rn.bank,3)+
     '，戶名：'+v(rn.acctName,3)+'，帳號：'+v(rn.acctNo,4)+'。　'+
     cb(rn.method==='other','其他')+'。</p>'+
     '</div></div>';

  /* 四 押金約定及返還 */
  h+='<div class="art"><div class="art-h">第四點　押金約定及返還</div><div class="art-b">'+
     '<p>押金由租賃雙方約定為'+v(dp.months,1)+'個月租金，金額為'+
     v(money(dp.amount))+'元整（最高不得超過二個月租金之總額）。'+
     '包租業應於簽訂住宅包租契約（以下簡稱本契約）之同時給付出租人。</p>'+
     '<p>前項押金，除有第十三點第三項、第十四點第四項及第十九點第二項得抵充之情形外，'+
     '出租人應於租期屆滿或租賃契約終止，包租業返還租賃住宅時，'+
     '返還押金或抵充本契約所生債務後之賸餘押金。</p>'+
     '</div></div>';

  /* 五 相關費用 */
  const feeRow=(label,val,extra)=>
    '<p class="ind1">'+label+'：'+cb(val==='owner','由出租人負擔')+'　'+
    cb(val==='biz','由包租業負擔')+'　'+cb(val==='other','其他')+'。'+(extra||'')+'</p>';
  h+='<div class="art"><div class="art-h">第五點　租賃期間相關費用之支付</div><div class="art-b">'+
     '<p>租賃期間，使用租賃住宅所生之相關費用如下：</p>'+
     feeRow('（一）管理費',f.mgmt,
       '<br><span class="ind2">租賃住宅每月'+v(f.mgmtRoom,3)+'元整；停車位每月'+v(f.mgmtPark,3)+'元整。</span>')+
     feeRow('（二）水費',f.water)+
     feeRow('（三）電費',f.elec)+
     feeRow('（四）瓦斯費',f.gas)+
     feeRow('（五）網路費',f.net)+
     '<p class="ind1">（六）其他費用及其支付方式：'+v(f.other,4)+'。</p>'+
     '</div></div>';

  /* 六 稅費 */
  h+='<div class="art"><div class="art-h">第六點　稅費負擔之約定</div><div class="art-b">'+
     '<p>本契約有關稅費，依下列約定辦理：</p>'+
     '<p class="ind1">（一）租賃住宅之房屋稅、地價稅，由出租人負擔。</p>'+
     '<p class="ind1">（二）出租人收取現金者，其銀錢收據應貼用之印花稅票，由出租人負擔。</p>'+
     '<p class="ind1">（三）其他稅費及其支付方式：'+v(b.taxOther,4)+'。</p>'+
     '<p>本契約租賃雙方'+cb(b.notarize,'同意')+cb(!b.notarize,'不同意')+'辦理公證；'+
     '同意辦理者，公證費及公證代辦費之負擔另以書面約定。</p>'+
     '</div></div>';

  /* 七 使用限制 */
  h+='<div class="art"><div class="art-h">第七點　使用租賃住宅之限制</div><div class="art-b">'+
     '<p>本租賃住宅係供轉租作居住使用，包租業不得變更用途。</p>'+
     '<p>出租人'+cb(b.otherUse,'同意')+cb(!b.otherUse,'不同意')+
     '包租業將本租賃住宅以出借或轉租以外之其他方式供他人居住使用。</p>'+
     '<p>包租業轉租本租賃住宅或經出租人同意提供他人使用者，應督促次承租人或使用人'+
     '遵守公寓大廈規約或其他住戶應遵行事項，不得違法使用、存放有爆炸性或易燃性物品，'+
     '影響公共安全、公共衛生或居住安寧。</p>'+
     '</div></div>';

  /* 八 修繕 */
  h+='<div class="art"><div class="art-h">第八點　修繕</div><div class="art-b">'+
     '<p>租賃住宅或附屬設備損壞時，應由包租業負責修繕，其修繕費用，'+
     '得由租賃雙方視損壞性質及責任歸屬，另行約定負擔方式'+
     '（詳如附件三「出租人負擔修繕費用之項目及範圍確認書」）。</p>'+
     '<p>前項約定由出租人負擔修繕費用者，包租業得請求出租人償還其費用'+
     '或於第三點約定之租金中扣除。</p>'+
     '</div></div>';

  /* 九 室內裝修 */
  h+='<div class="art"><div class="art-h">第九點　室內裝修</div><div class="art-b">'+
     '<p>出租人'+cb(b.decorAllow,'同意')+cb(!b.decorAllow,'不同意')+
     '包租業將本租賃住宅之全部或一部分進行室內裝修。</p>'+
     '<p>前項經出租人同意室內裝修者，包租業應依相關法令規定辦理，'+
     '且不得損害原有建築結構之安全。</p>'+
     '<p>第一項室內裝修所需費用，由'+cb(b.decorCostBy==='owner','出租人')+
     cb(b.decorCostBy==='biz','包租業')+'負擔或'+cb(b.decorCostBy==='other','其他')+'。</p>'+
     '<p>包租業經出租人同意裝修者，其裝修增設部分若有損壞，由包租業負責修繕並負擔費用。</p>'+
     '<p>第二項情形，包租業返還租賃住宅時，'+
     cb(b.decorRestore==='回復原狀','應負責回復原狀')+'　'+
     cb(b.decorRestore==='現況返還','現況返還')+'　'+
     cb(b.decorRestore==='其他','其他')+'。</p>'+
     '</div></div>';

  /* 十 出租人義務 */
  h+='<div class="art"><div class="art-h">第十點　出租人之義務及責任</div><div class="art-b">'+
     '<p>本契約租賃期間，出租人之義務及責任如下：</p>'+
     '<p class="ind1">（一）應出示有權出租本租賃住宅之證明文件及國民身分證或'+
       '其他足資證明身分之文件，供包租業核對。</p>'+
     '<p class="ind1">（二）應於簽訂本契約時，提供同意本租賃標的之全部或一部分轉租之同意書，'+
       '並載明租賃標的範圍、租賃期間及得終止本契約之事由。</p>'+
     '<p class="ind1">（三）應以合於所約定居住使用之租賃住宅，交付包租業，'+
       '並於租賃期間保持其合於居住使用之狀態。</p>'+
     '<p class="ind1">（四）簽訂本契約，應先向包租業說明租賃住宅由出租人負擔修繕費用之項目及範圍，'+
       '並提供有修繕必要時之聯絡方式。</p>'+
     '<p>前項第二款、第四款之同意轉租及負擔修繕費用之項目、範圍，'+
     '如附件二「出租人同意轉租範圍、租賃期間及終止租約事由確認書」及'+
     '附件三「出租人負擔修繕費用之項目及範圍確認書」。</p>'+
     '</div></div>';

  /* 十一 包租業義務 */
  h+='<div class="art"><div class="art-h">第十一點　包租業之義務及責任</div><div class="art-b">'+
     '<p>本契約租賃期間，包租業之義務及責任如下：</p>'+
     '<p class="ind1">（一）應出示租賃住宅服務業登記證影本，供出租人核對。</p>'+
     '<p class="ind1">（二）應以善良管理人之注意，保管、使用、收益租賃住宅。</p>'+
     '<p class="ind1">（三）與次承租人簽訂轉租契約時，不得逾出租人同意轉租之標的範圍及租賃期間。</p>'+
     '<p class="ind1">（四）應於簽訂轉租契約後三十日內，以書面將轉租標的範圍、租賃期間、'+
       '次承租人之姓名及其通訊地址等相關資料通知出租人。</p>'+
     '<p class="ind1">（五）應執行日常修繕維護並製作紀錄，提供出租人查詢或取閱。</p>'+
     '<p class="ind1">（六）應於收受出租人之有關費用或文件時，開立統一發票或掣給收據。</p>'+
     '<p class="ind1">（七）應配合出租人申請減徵稅捐需要，提供相關證明。</p>'+
     '<p class="ind1">（八）不得轉讓出租人同意轉租權利及其管理業務。</p>'+
     '<p>包租業違反前項各款規定之一，致出租人受有損害者，應負賠償責任。'+
     '但前項第二款情形，包租業依約定之方法或依租賃住宅之性質使用、收益，'+
     '致有變更或毀損者，不在此限。</p>'+
     '</div></div>';

  /* 十二 部分滅失 */
  h+='<div class="art"><div class="art-h">第十二點　租賃住宅部分滅失</div><div class="art-b">'+
     '<p>租賃關係存續中，因不可歸責於包租業及次承租人之事由，致租賃住宅之一部滅失者，'+
     '包租業得按滅失之部分，請求減少租金。</p>'+
     '</div></div>';

  /* 十三 提前終止約定 */
  h+='<div class="art"><div class="art-h">第十三點　提前終止租約之約定</div><div class="art-b">'+
     '<p>本契約於期限屆滿前，除第十六點及第十七點規定外，租賃雙方'+
     cb(b.earlyTerm,'得')+cb(!b.earlyTerm,'不得')+
     '就租賃住宅之全部或一部終止租約。</p>'+
     '<p>依約定得終止租約者，租賃之一方應至少於終止前一個月通知他方。'+
     '一方未為先期通知而逕行終止租約者，應賠償他方最高不得超過一個月租金額之違約金。</p>'+
     '<p>前項包租業應賠償之違約金得由第四點第一項規定之押金中抵充。</p>'+
     '<p>租期屆滿前，依第二項規定終止租約者，出租人已預收之租金應返還予包租業。</p>'+
     '</div></div>';

  h+=renderBZ_2(d);
  h+='</div>';
  return h;
}

/* 包租契約第十四點至第二十三點。拆成兩個函數純粹是為了可讀性，
   輸出仍在同一張 .paper 內連續排版。 */
function renderBZ_2(d){
  const b=d.bz;
  let h='';

  h+='<div class="art"><div class="art-h">第十四點　租賃住宅之返還</div><div class="art-b">'+
     '<p>租期屆滿或租賃契約終止時，包租業應即結算第五點約定之相關費用，'+
     '並會同出租人共同完成屋況及附屬設備之點交手續，包租業應將租賃住宅返還出租人，'+
     '並督促次承租人或使用人遷出戶籍或其他登記。</p>'+
     '<p>前項租賃之一方未會同點交，經他方定相當期限催告仍不會同者，視為完成點交。</p>'+
     '<p>包租業未依第一項規定返還租賃住宅時，出租人應明示不以不定期限繼續契約，'+
     '並得向包租業請求未返還租賃住宅期間之相當月租金額，及相當月租金額計算之違約金'+
     '（未足一個月者，以日租金折算）至返還為止。</p>'+
     '<p>前項金額及包租業未繳清第五點約定之相關費用，'+
     '出租人得由第四點第一項規定之押金中抵充。</p>'+
     '</div></div>';

  h+='<div class="art"><div class="art-h">第十五點　租賃住宅所有權之讓與</div><div class="art-b">'+
     '<p>出租人於租賃住宅交付後，包租業或次承租人占有中，縱將其所有權讓與第三人，'+
     '本契約對於受讓人仍繼續存在。</p>'+
     '<p>前項情形，出租人應移交押金及已預收之租金予受讓人，並以書面通知包租業。</p>'+
     '<p>本契約如未經公證，其期限逾五年者，不適用第一項之規定。</p>'+
     '</div></div>';

  const OT=['出租人為重新建築而必要收回。',
    '包租業遲付租金之總額達二個月之金額，經出租人定相當期限催告，仍不為支付。',
    '包租業積欠管理費或其他應負擔之費用達二個月之租金額，經出租人定相當期限催告，仍不為支付。',
    '包租業違反第七點第一項規定，擅自變更用途，經出租人阻止仍繼續為之。',
    '包租業違反第七點第二項規定，未經出租人同意，擅自將本租賃住宅以出借或轉租以外之其他方式供他人使用，經出租人阻止仍繼續為之。',
    '包租業毀損租賃住宅或附屬設備，經出租人定相當期限催告修繕仍不為修繕或相當之賠償。',
    '包租業違反第八點第一項規定，未履行修繕義務。',
    '包租業違反第九點第一項規定，未經出租人同意，擅自進行室內裝修，經出租人阻止仍繼續為之。',
    '包租業違反第九點第二項規定，未依相關法令規定進行室內裝修，經出租人阻止仍繼續為之。',
    '包租業違反第九點第二項規定，進行室內裝修，損害原有建築結構之安全。',
    '包租業轉租本租賃住宅，違反第十一點第一項第三款規定，逾出租人同意轉租之範圍或期間。',
    '包租業違反第十一點第一項第八款規定，將出租人同意轉租權利及其管理業務轉讓予第三人，經出租人阻止仍繼續為之。',
    '包租業經主管機關撤銷、廢止其許可或登記。'];
  const CN=['一','二','三','四','五','六','七','八','九','十','十一','十二','十三'];
  h+='<div class="art"><div class="art-h">第十六點　出租人提前終止租約</div><div class="art-b">'+
     '<p>租賃期間有下列情形之一者，出租人得提前終止租約，包租業不得要求任何賠償：</p>'+
     OT.map((x,i)=>'<p class="ind1">（'+CN[i]+'）'+x+'</p>').join('')+
     '<p>出租人依前項規定提前終止租約者，應依下列規定期限，檢附相關事證，以書面通知包租業：</p>'+
     '<p class="ind1">（一）依前項第一款規定終止者，於終止前三個月。</p>'+
     '<p class="ind1">（二）依前項第二款至第十三款規定終止者，於終止前三十日。'+
       '但前項第十款有危害公共安全或有第十三款之情形者，得不先期通知。</p>'+
     '</div></div>';

  const BT=['租賃住宅或附屬設備損壞，應由出租人負擔修繕費用者，經包租業定相當期限催告，出租人仍不於期限內支付。',
    '租賃住宅因不可歸責於包租業及次承租人之事由致一部滅失，且其存餘部分不能達租賃之目的。',
    '租賃住宅有危及次承租人或其同居人之安全或健康之瑕疵。',
    '因第三人就租賃住宅主張其權利，致次承租人不能為約定之居住使用。'];
  h+='<div class="art"><div class="art-h">第十七點　包租業提前終止租約</div><div class="art-b">'+
     '<p>租賃期間有下列情形之一者，包租業得提前終止租約之全部或一部：</p>'+
     BT.map((x,i)=>'<p class="ind1">（'+CN[i]+'）'+x+'</p>').join('')+
     '<p>包租業依前項各款規定提前終止租約者，應於終止前三十日，檢附相關事證，'+
     '以書面通知出租人。但前項第三款情況危急者，得不先期通知。</p>'+
     '</div></div>';

  h+='<div class="art"><div class="art-h">第十八點　出租人提前終止租約之處理</div><div class="art-b">'+
     '<p>包租業應於知悉出租人提前終止本契約之次日起五日內通知次承租人終止轉租契約，'+
     '協調返還租賃住宅、執行屋況及附屬設備點交事務、'+
     '退還向次承租人預收之租金及全部或一部押金或履行其他應盡事宜。</p>'+
     '<p>前項出租人提前終止本契約之情形，於包租業因故停業、解散或他遷不明時，'+
     '出租人得請求所在地租賃住宅服務商業同業公會或其全國聯合會協調返還租賃住宅，'+
     '該同業公會或其全國聯合會不得拒絕。</p>'+
     '<p>前二項出租人提前終止本契約之情形，因可歸責於包租業之事由，'+
     '致出租人或次承租人受損害時，包租業應負賠償責任。</p>'+
     '</div></div>';

  h+='<div class="art"><div class="art-h">第十九點　遺留物之處理</div><div class="art-b">'+
     '<p>本契約租期屆滿或提前終止租約，依第十四點完成點交或視為完成點交之手續後，'+
     '包租業或次承租人仍於租賃住宅有遺留物者，除租賃雙方另有約定外，'+
     '經出租人定相當期限向包租業催告，逾期仍不取回時，視為拋棄其所有權。</p>'+
     '<p>出租人處理前項遺留物所生費用，得由第四點第一項規定之押金中抵充，'+
     '如有不足，並得向包租業請求給付不足之費用。</p>'+
     '</div></div>';

  h+='<div class="art"><div class="art-h">第二十點　履行本契約之通知</div><div class="art-b">'+
     '<p>除本契約另有約定外，租賃雙方相互間之通知，以郵寄為之者，'+
     '應以本契約所記載之地址為準；如因地址變更未告知他方，致通知無法到達時，'+
     '以第一次郵遞之日期推定為到達日。</p>'+
     '<p>前項之通知得經租賃雙方約定以'+
     cb(b.notice.email,'電子郵件信箱：')+(b.notice.email?v(d.owner.email):'')+'　'+
     cb(b.notice.sms,'手機簡訊')+'　'+
     cb(b.notice.im,'即時通訊軟體')+'以文字顯示方式為之。</p>'+
     '</div></div>';

  h+='<div class="art"><div class="art-h">第二十一點　其他約定</div><div class="art-b">'+
     '<p>本契約租賃雙方'+cb(b.notarize,'同意')+cb(!b.notarize,'不同意')+'辦理公證。</p>'+
     '<p>本契約經辦理公證者，租賃雙方'+cb(!b.notarize,'不同意')+'；'+
     cb(false,'同意')+'公證書載明下列事項應逕受強制執行：</p>'+
     '<p class="ind1">'+cb(false,'（一）包租業如於租期屆滿後不返還租賃住宅。')+'</p>'+
     '<p class="ind1">'+cb(false,'（二）包租業未依約給付之欠繳租金、費用及出租人或租賃住宅所有權人代繳之管理費，或違約時應支付之金額。')+'</p>'+
     '<p class="ind1">'+cb(false,'（三）出租人如於租期屆滿或本契約終止時，應返還包租業之全部或一部押金。')+'</p>'+
     '<p>公證書載明金錢債務逕受強制執行時，如有保證人者，前項後段第'+v('',2)+'款之效力及於保證人。</p>'+
     '</div></div>';

  h+='<div class="art"><div class="art-h">第二十二點　契約及其相關附件效力</div><div class="art-b">'+
     '<p>本契約自簽約日起生效，租賃雙方各執一份契約正本'+
     '（以電子文件方式訂立者，雙方各自留存同一份電子正本及其下載之 PDF 檔）。</p>'+
     '<p>本契約廣告及相關附件視為本契約之一部分。本契約之附件包括：'+
     '附件一 租賃標的現況確認書、'+
     '附件二 出租人同意轉租範圍、租賃期間及終止租約事由確認書、'+
     '附件三 出租人負擔修繕費用之項目及範圍確認書。</p>'+
     '</div></div>';

  h+='<div class="art"><div class="art-h">第二十三點　當事人及相關人員基本資料</div><div class="art-b">'+
     '<table class="t">'+
     '<tr><th style="width:15%">出租人</th><td>'+
       '姓名（名稱）：'+v(d.owner.name)+'<br>'+
       '戶籍地址：'+v(d.owner.hukou)+'<br>'+
       '通訊地址：'+v(d.owner.mail)+'<br>'+
       '聯絡電話：'+v(d.owner.tel)+
       '</td></tr>'+
     '<tr><th>包租業</th><td>'+
       '公司名稱：'+v(d.biz.name)+'　統一編號：'+v(d.biz.taxid)+'<br>'+
       '代表人姓名：'+v(d.biz.rep)+'　租賃住宅服務業登記證字號：'+v(d.biz.licNo)+'<br>'+
       '營業地址：'+v(d.biz.addr)+'<br>'+
       '聯絡電話：'+v(d.biz.tel)+'　電子郵件信箱：'+v(d.biz.email)+
       '</td></tr>'+
     '<tr><th>租賃住宅<br>管理人員</th><td>'+
       '姓名：'+v(d.mgr.name)+'　證書字號：'+v(d.mgr.certNo)+'<br>'+
       '通訊地址：'+v(d.mgr.addr)+'<br>'+
       '聯絡電話：'+v(d.mgr.tel)+'　電子郵件信箱：'+v(d.mgr.email)+
       '</td></tr>'+
     '</table>'+
     '</div></div>';

  h+=ownerSignBlock(d,'包租業',d.biz.name,'出租人',d.owner.name,null);
  return h;
}

/* ══════════════════════════════════════════════════════════
   簽署區。withReview 傳入審閱資料時才印審閱確認段
   （包租契約無法定審閱期，委管契約有至少三日審閱期）。
   ══════════════════════════════════════════════════════════ */
function ownerSignBlock(d,leftLabel,leftName,rightLabel,rightName,review){
  let h='<div class="signblock">';

  if(review){
    h+='<p style="font-size:11.5px;line-height:1.75;border:1px solid #333;padding:8px 10px;margin:0 0 12px">'+
       cb(true,'')+'　本人（委託人）確認已於'+v(rocStr(review.handedAt))+
       '收到本契約及其附件並攜回審閱，審閱期間'+v(review.days,2)+
       '日（契約審閱期間至少三日）。</p>';
  }

  h+='<p style="font-size:11.5px;line-height:1.75;border:1px solid #333;padding:8px 10px;margin:0 0 12px">'+
     cb(true,'')+'　雙方同意以電子文件及電子簽章方式訂立本契約，'+
     '並瞭解依電子簽章法規定，其效力與親筆簽名相同。'+
     '<br><span style="color:#666">系統紀錄之首次開啟契約時間：'+v(d.sign.openedAt)+'</span>'+
     '</p>';

  h+='<div class="sigrow">'+
     '<div class="sigcol">'+
       '<div class="lb">'+esc(leftLabel)+'</div>'+
       '<div class="fl">'+esc(leftName||'')+'</div>'+
       '<div class="sigbox">（簽章）</div>'+
     '</div>'+
     '<div class="sigcol">'+
       '<div class="lb">'+esc(rightLabel)+'</div>'+
       '<div class="fl">'+esc(rightName||'')+'</div>'+
       '<div class="sigbox">'+(d.sign.sigImg?'<img src="'+d.sign.sigImg+'">':'（線上簽名）')+'</div>'+
     '</div>'+
     '</div>';

  h+='<div class="audit"><b>電子簽署稽核紀錄</b>（系統自動產生，不可修改）<br>'+
     '簽署完成時間：'+v(d.sign.signedAt)+'　　簽署來源 IP：'+v(d.sign.ip)+'<br>'+
     '簽署裝置：'+v(d.sign.ua)+'<br>'+
     '簽署人身分核對：國民身分證統一編號 '+v(maskId(d.owner.idNo))+
     '（完整字號僅存於系統，不揭露於本契約）<br>'+
     '契約內容雜湊值：'+v(d.sign.hash)+
     '</div>';

  const r=roc(d.sign.signedAt?d.sign.signedAt.slice(0,10):'');
  h+='<div class="datefoot">中　華　民　國　'+v(r.y,3)+'　年　'+v(r.m,2)+'　月　'+v(r.d,2)+'　日</div>';
  h+='</div>';
  return h;
}

/* ══════════════════════════════════════════════════════════
   租賃住宅委託管理契約書（依內政部應記載事項十五點）
   ══════════════════════════════════════════════════════════ */
function renderWG(d){
  const w=d.wg,t=w.term,fe=w.fee,o=w.opt;
  let h='<div class="paper">';

  h+='<h1 class="doc-title">租 賃 住 宅 委 託 管 理 契 約 書</h1>'+
     '<div class="doc-sub">依內政部「租賃住宅委託管理定型化契約應記載及不得記載事項」'+
     '（中華民國108年9月5日台內地字第1080264470號公告，108年12月1日生效）製作</div>'+
     '<div class="doc-no">契約編號：'+v(d.no)+'</div>';

  h+='<p style="margin:0 0 12px">立契約書人　委託人（出租人）'+v(d.owner.name)+
     '、受託人（租賃住宅代管業）'+v(d.biz.name)+
     '，茲就租賃住宅之委託管理事宜，約定條款如下：</p>';

  /* 一 審閱期間 */
  h+='<div class="art"><div class="art-h">第一點　契約審閱期間</div><div class="art-b">'+
     '<p>租賃住宅委託管理契約（以下簡稱本契約）於'+v(rocStr(w.review.handedAt))+
     '經委託人攜回審閱'+v(w.review.days,2)+'日。（契約審閱期間至少三日）</p>'+
     '<p style="color:#666;font-size:11.5px">'+
     '本契約以電子文件方式提供，委託人得自收到簽署連結時起隨時下載、列印及審閱；'+
     '系統紀錄之首次開啟時間為'+v(d.sign.openedAt)+'。</p>'+
     '</div></div>';

  /* 二 委託管理標的 */
  h+='<div class="art"><div class="art-h">第二點　委託管理標的</div><div class="art-b">'+
     propBlock(d,'wg')+'</div></div>';

  /* 三 委託管理期間 */
  h+='<div class="art"><div class="art-h">第三點　委託管理期間</div><div class="art-b">'+
     '<p>委託管理期間自'+v(rocStr(t.from))+'起至'+v(rocStr(t.to))+'止'+
     '（共'+v(days(t.from,t.to),3)+'日）。</p>'+
     '</div></div>';

  /* 四 報酬 */
  h+='<div class="art"><div class="art-h">第四點　報酬約定及給付</div><div class="art-b">'+
     '<p>委託人應按'+cb(fe.payUnit==='月','月')+cb(fe.payUnit==='期','期')+
     '（'+v(fe.payUnit==='期'?fe.periods:'',1)+'個月）給付報酬予受託人；其報酬為'+
     cb(fe.mode==='pct','委託管理標的月租金額百分之')+(fe.mode==='pct'?v(fe.pct,2):'')+'　'+
     cb(fe.mode==='fix','新臺幣（下同）')+(fe.mode==='fix'?v(money(fe.amount)):'')+'元，'+
     '委託人應於每'+cb(fe.payUnit==='月','月')+cb(fe.payUnit==='期','期')+
     v(fe.payDay,1)+'日前給付，非有正當理由不得拖延或拒絕，'+
     '受託人於委託管理期間非有正當理由亦不得要求調漲報酬。</p>'+
     '<p>前項報酬給付方式：'+cb(fe.method==='cash','現金繳付')+'　'+
     cb(fe.method==='deduct','於代為收取之租金內扣付')+'　'+
     cb(fe.method==='transfer','轉帳繳付')+'：金融機構：'+v(fe.bank,3)+
     '，戶名：'+v(fe.acctName,3)+'，帳號：'+v(fe.acctNo,4)+'　'+
     cb(fe.method==='other','其他')+'。</p>'+
     '</div></div>';

  /* 五 委託管理項目 */
  h+='<div class="art"><div class="art-h">第五點　委託管理項目</div><div class="art-b">'+
     '<p>委託管理期間，受託人代為管理項目如下：</p>'+
     '<p class="ind1">（一）屋況與設備點交。</p>'+
     '<p class="ind1">（二）居住者身分之確認。</p>'+
     '<p class="ind1">（三）向承租人催收（繳）租金及相關費用。</p>'+
     '<p class="ind1">（四）日常修繕維護事項：</p>'+
     '<p class="ind2">1. 租賃住宅及其附屬設備檢查及維護。</p>'+
     '<p class="ind2">2. 修繕費用通報及修繕或督促修繕。</p>'+
     '<p class="ind1">（五）糾紛協調處理。</p>'+
     '<p class="ind1">（六）結算相關費用。</p>'+
     '<p class="ind1">（七）租賃關係消滅時，督促承租人返還租賃住宅並遷出戶籍或其他登記。</p>'+
     '<p class="ind1">（八）其他項目：</p>'+
     '<p class="ind2">'+cb(o.collectRent,'1. 收取租金，交付方式：')+
       (o.collectRent?v(o.rentDeliver,4):'')+'</p>'+
     '<p class="ind2">'+cb(o.collectDeposit,'2. 收取押金，交付方式：')+
       (o.collectDeposit?v(o.depositDeliver,4):'')+'</p>'+
     '<p class="ind2">'+cb(o.manageDeposit,'3. 管理押金。')+'</p>'+
     '<p class="ind2">'+cb(o.advance,'4. 墊付相關費用。')+'</p>'+
     '<p class="ind2">'+cb(o.clean,'5. 處理委託管理標的專有部分之共用空間清潔業務。')+'</p>'+
     '<p class="ind2">'+cb(o.leftover,'6. 遺留物之處理。')+'</p>'+
     '<p class="ind2">'+cb(o.furniture,'7. 租購家具、電器設備。')+'</p>'+
     '</div></div>';

  /* 六 違反使用限制 */
  h+='<div class="art"><div class="art-h">第六點　違反使用限制之處理</div><div class="art-b">'+
     '<p>委託管理標的係供居住使用，承租人如有變更用途、未遵守公寓大廈規約或'+
     '其他住戶應遵行事項，違法使用、存放有爆炸性或易燃性物品，影響公共安全、'+
     '公共衛生或居住安寧，受託人應予制止，並即向委託人報告及提出處理方式之建議。</p>'+
     '</div></div>';

  /* 七 修繕之處理 */
  h+='<div class="art"><div class="art-h">第七點　修繕之處理</div><div class="art-b">'+
     '<p>委託管理標的經租賃契約約定由委託人負責修繕者，得委由受託人修繕；'+
     '其費用，由委託人負擔。</p>'+
     '<p>委託管理標的經租賃契約約定由承租人負責修繕及負擔費用者，得由受託人代為督促之；'+
     '承租人對於應負責修繕之項目或費用有爭執時，受託人應代為協調。</p>'+
     '</div></div>';

  /* 八 委託人義務 */
  h+='<div class="art"><div class="art-h">第八點　委託人之義務及責任</div><div class="art-b">'+
     '<p>委託人應據實提供附件之委託管理標的現況確認書相關資訊，'+
     '並確保合於租賃契約所約定居住使用之狀態。</p>'+
     '<p>簽訂本契約時，委託人應出示有權委託管理本租賃住宅之證明文件、'+
     '國民身分證或其他足資證明身分之文件，供受託人核對；'+
     '如有同意受託人代為收取租金、押金者，並應提供交付之方式。</p>'+
     '<p>簽訂本契約時，委託人應向受託人說明租賃契約約定應由委託人負責修繕之項目、範圍、'+
     '有修繕必要時之聯絡方式及其他相關事項；簽訂本契約後，'+
     '委託人並應以書面方式告知承租人本契約相關事項。</p>'+
     '</div></div>';

  /* 九 受託人義務 */
  h+='<div class="art"><div class="art-h">第九點　受託人之義務及責任</div><div class="art-b">'+
     '<p>委託管理期間，受託人之義務如下：</p>'+
     '<p class="ind1">（一）應出示租賃住宅服務業登記證影本，供委託人核對。</p>'+
     '<p class="ind1">（二）應負責督促承租人以善良管理人之注意，保管、使用租賃住宅。</p>'+
     '<p class="ind1">（三）依第五點第一款規定，代為執行屋況與設備點交者，'+
       '應於租賃期間屆滿或租賃契約提前終止時，先行協助結算相關費用、製作代收代付清單、'+
       '結算承租人於租賃期間應繳未繳之費用與協助執行屋況及附屬設備點交，'+
       '並通知委託人將扣除未繳費用之賸餘押金返還承租人。</p>'+
     '<p class="ind1">（四）依第五點第三款規定，代為向承租人催收（繳）租金及相關費用者，'+
       '應於繳款期限屆滿後'+v(w.dunDays,1)+'日內催收（繳）。</p>'+
     '<p class="ind1">（五）依第五點第四款或第八款第五目規定，代為辦理日常修繕維護或清潔事務者，'+
       '應製作執行紀錄，提供委託人查詢或取閱。</p>'+
     '<p class="ind1">（六）依第五點第五款規定，代為協調處理租賃糾紛者，'+
       '應包括承租人使用委託管理標的之糾紛。</p>'+
     '<p class="ind1">（七）依第五點第八款第一目或第二目規定，代為收取租金或押金者，'+
       '應按約定交付方式，於代為收取之日起'+v(w.deliverDays,1)+
       '日（不得超過三十日）內交付委託人。但委任雙方另訂有保管約定者，依其約定。</p>'+
     '<p class="ind1">（八）依第五點第八款第三目規定，代為管理押金者，'+
       '除於租賃關係消滅時，抵充承租人因租賃契約所生之債務外，不得動支，'+
       '並應於承租人返還委託管理標的時，經委託人同意後，'+
       '代為返還押金或抵充債務後之賸餘押金予承租人。</p>'+
     '<p class="ind1">（九）應於收受委託人之有關報酬或文件時，開立統一發票或掣給收據。</p>'+
     '<p class="ind1">（十）應配合委託人申請減徵稅捐需要，提供相關證明。</p>'+
     '<p class="ind1">（十一）不得委託他代管業執行租賃住宅管理業務。</p>'+
     '<p>因可歸責於受託人之事由而違反前項各款規定，致委託人受有損害者，應負賠償責任。</p>'+
     '</div></div>';

  /* 十 返還之處理 */
  h+='<div class="art"><div class="art-h">第十點　租賃住宅返還之處理</div><div class="art-b">'+
     '<p>委託管理標的之租賃關係消滅時，受託人應即結算相關費用，'+
     '督促承租人將租賃住宅返還委託人，並遷出戶籍或其他登記。</p>'+
     '<p>因可歸責於受託人之事由而違反前項規定，致委託人受有損害者，應負賠償責任。</p>'+
     '</div></div>';

  /* 十一 委託人提前終止 */
  const WT=['受託人違反第九點第一項第六款代為協調處理租賃糾紛之規定，經委託人定相當期間催告，仍不於期限內處理。',
    '受託人違反第九點第一項第七款依期限交付代為收取之租金或押金之規定，經委託人定相當期間催告，仍不於期限內交付。',
    '受託人違反第九點第一項第十一款規定，委託他代管業執行租賃住宅管理業務。',
    '委託管理標的之租賃關係消滅。',
    '委託管理標的全部滅失，或一部滅失且其存餘部分難以繼續居住。',
    '受託人經主管機關撤銷、廢止許可或租賃住宅服務業登記。'];
  const CN2=['一','二','三','四','五','六'];
  h+='<div class="art"><div class="art-h">第十一點　委託人提前終止契約</div><div class="art-b">'+
     '<p>委託管理期間有下列情形之一者，委託人得提前終止本契約：</p>'+
     WT.map((x,i)=>'<p class="ind1">（'+CN2[i]+'）'+x+'</p>').join('')+
     '</div></div>';

  /* 十二 受託人提前終止 */
  h+='<div class="art"><div class="art-h">第十二點　受託人提前終止契約</div><div class="art-b">'+
     '<p>委託管理期間有下列情形之一者，受託人得提前終止本契約：</p>'+
     '<p class="ind1">（一）因委託人違反第七點第一項、第八點第一項或第三項後段規定，'+
       '致受託人無法繼續管理委託標的。</p>'+
     '<p class="ind1">（二）委託管理標的之租賃關係消滅且已完成第十點第一項規定事項。</p>'+
     '</div></div>';

  /* 十三 通知 */
  h+='<div class="art"><div class="art-h">第十三點　履行本契約之通知</div><div class="art-b">'+
     '<p>除本契約另有約定外，委任雙方相互間之通知，以郵寄為之者，'+
     '應以本契約所記載之地址為準；如因地址變更未告知他方，致通知無法到達時，'+
     '以第一次郵遞之日期推定為到達日。</p>'+
     '<p>前項之通知得經委任雙方約定以'+
     cb(w.notice.email,'電子郵件信箱：')+(w.notice.email?v(d.owner.email):'')+'　'+
     cb(w.notice.sms,'手機簡訊')+'　'+
     cb(w.notice.im,'即時通訊軟體')+'以文字顯示方式為之。</p>'+
     '</div></div>';

  /* 十四 契約效力 */
  h+='<div class="art"><div class="art-h">第十四點　契約及相關附件效力</div><div class="art-b">'+
     '<p>本契約自簽約日起生效，委任雙方各執一份契約正本'+
     '（以電子文件方式訂立者，雙方各自留存同一份電子正本及其下載之 PDF 檔）。</p>'+
     '<p>受託人之廣告及相關附件視為本契約之一部分。'+
     '本契約之附件為「委託管理標的現況確認書」。</p>'+
     '</div></div>';

  /* 十五 基本資料 */
  h+='<div class="art"><div class="art-h">第十五點　當事人及相關人員基本資料</div><div class="art-b">'+
     '<table class="t">'+
     '<tr><th style="width:15%">委託人</th><td>'+
       '姓名：'+v(d.owner.name)+'<br>'+
       '戶籍地址：'+v(d.owner.hukou)+'<br>'+
       '通訊地址：'+v(d.owner.mail)+'<br>'+
       '聯絡電話：'+v(d.owner.tel)+
       '</td></tr>'+
     '<tr><th>受託人</th><td>'+
       '公司名稱：'+v(d.biz.name)+'　統一編號：'+v(d.biz.taxid)+'<br>'+
       '代表人姓名：'+v(d.biz.rep)+'　租賃住宅服務業登記證字號：'+v(d.biz.licNo)+'<br>'+
       '營業地址：'+v(d.biz.addr)+'<br>'+
       '聯絡電話：'+v(d.biz.tel)+'　電子郵件信箱：'+v(d.biz.email)+
       '</td></tr>'+
     '<tr><th>租賃住宅<br>管理人員</th><td>'+
       '姓名：'+v(d.mgr.name)+'　證書字號：'+v(d.mgr.certNo)+'<br>'+
       '通訊地址：'+v(d.mgr.addr)+'<br>'+
       '聯絡電話：'+v(d.mgr.tel)+'　電子郵件信箱：'+v(d.mgr.email)+
       '</td></tr>'+
     '</table>'+
     '</div></div>';

  h+=ownerSignBlock(d,'受託人（代管業）',d.biz.name,'委託人（出租人）',d.owner.name,w.review);
  h+='</div>';
  return h;
}

/* ══════════════════════════════════════════════════════════
   現況確認書。包租＝附件一「租賃標的現況確認書」，
   委管＝附件「委託管理標的現況確認書」。
   兩份的十二個項次相同，但第5、6、7、8、9項的處理方式選項與
   當事人稱謂不同（委管多了「委託受託人修繕／改善」這個選項，
   因為代管業本來就能受託處理）。共用一個函數並用 isBZ 分岔，
   比複製兩份更不容易讓兩邊條文走鐘。
   ══════════════════════════════════════════════════════════ */
function renderStatus(d,mode){
  const isBZ=(mode==='bz'),a=d.a1,p=d.prop;
  const me=isBZ?'出租人':'委託人';
  const you=isBZ?'包租業':'受託人';
  const rows=[];

  rows.push(['1',
    cb(a.illegal,'有')+cb(!a.illegal,'無')+'包括未登記之改建、增建、加建、違建部分'+
    (a.illegal?'：'+v(a.illegalNote,6):'。'),
    '若為違建（未依法申請增、加建之建物），'+me+'應確實加以說明，使'+you+
    (isBZ?'或次承租人':'（代管業）')+'得以充分認知此範圍之建物隨時有被拆除之虞或其他危險。']);

  rows.push(['2',
    '建物型態：'+v(p.bldgType)+'。<br>建物現況格局：'+
    v(p.layout.room,1)+'房（間、室）'+v(p.layout.hall,1)+'廳'+v(p.layout.bath,1)+'衛　'+
    cb(p.layout.partition,'有')+cb(!p.layout.partition,'無')+'隔間。',
    '一、建物型態：（一）一般建物：單獨所有權無共有部分（包括獨棟、連棟、雙併等）。'+
    '（二）區分所有建物：公寓（五樓含以下無電梯）、透天厝、店面（店鋪）、辦公商業大樓、'+
    '住宅或複合型大樓（十一層含以上有電梯）、華廈（十層含以下有電梯）、'+
    '套房（一房、一廳、一衛）等。（三）其他特殊建物：如工廠、廠辦、農舍、倉庫等型態。<br>'+
    '二、現況格局（例如：房間、廳、衛浴數，有無隔間）。']);

  rows.push(['3',
    cb(a.hasParkingDetail,'有')+cb(!a.hasParkingDetail,'無')+'汽車停車位。'+
    '汽車停車位種類及編號：地上（下）第'+v('',1)+'層'+cb(false,'平面式停車位')+
    cb(false,'機械式停車位')+cb(false,'其他')+'，編號：第'+v('',1)+'號車位'+v('',1)+'個，'+
    cb(false,'有')+cb(true,'無')+'獨立權狀。'+
    cb(false,'有')+cb(true,'無')+'檢附分管協議及圖說。<br>'+
    '機車停車位：地上（下）第'+v('',1)+'層，編號第'+v('',1)+'號車位'+v('',1)+
    '個或其位置示意圖。','']);

  rows.push(['4',
    cb(a.fireAlarm,'有')+cb(!a.fireAlarm,'無')+'住宅用火災警報器。<br>'+
    cb(a.otherFire,'有')+cb(!a.otherFire,'無')+'其他消防設施，若有，項目：'+
    v((a.otherFireItems||[]).join('、'),6)+'。<br>'+
    cb(a.fireCheck,'有')+cb(!a.fireCheck,'無')+'定期辦理消防安全檢查。',
    '非屬應設置火警自動警報設備之住宅所有權人應依消防法第六條第五項規定'+
    '設置及維護住宅用火災警報器。']);

  /* 第5項：委管版多一個「委託受託人修繕」選項 */
  rows.push(['5',
    cb(a.leak,'有')+cb(!a.leak,'無')+'滲漏水之情形'+(a.leak?'，滲漏水處：'+v(a.leakWhere,4):'')+'。<br>'+
    '滲漏水處之處理：'+cb(a.leakFix==='fix','由'+me+'修繕後交屋')+'　'+
    (isBZ?'':cb(a.leakFix==='entrust','委託受託人修繕')+'　')+
    cb(a.leakFix==='asis','以現況交屋')+'　'+cb(a.leakFix==='other','其他'),'']);

  rows.push(['6',
    cb(a.radiation,'有')+cb(!a.radiation,'無')+'曾經做過輻射屋檢測？若有，請檢附檢測證明文件。<br>'+
    (isBZ
      ? '檢測結果是否有輻射異常？'+cb(a.radiationResult==='yes','是')+
        cb(a.radiationResult!=='yes','否')+'。'
      : '檢測結果'+cb(a.radiationResult==='yes','有')+cb(a.radiationResult!=='yes','無')+
        '輻射異常，若有異常之處理：'+cb(a.radiationFix==='fix','由委託人改善後交屋')+'　'+
        cb(a.radiationFix==='entrust','委託受託人改善')+'　'+
        cb(a.radiationFix==='asis','以現況交屋')+'　'+cb(a.radiationFix==='other','其他')),
    '七十一年至七十三年領得使用執照之建築物，應特別留意檢測。'+
    '如欲進行改善，應向核能安全委員會洽詢技術協助。']);

  rows.push(['7',
    cb(a.chloride,'有')+cb(!a.chloride,'無')+
    '曾經做過（鋼筋）混凝土中水溶性氯離子含量檢測（例如海砂屋檢測事項）；'+
    '若有，檢測結果：'+v(a.chlorideResult,6)+'。'+
    (isBZ?'':'<br>'+cb(a.chlorideOver,'有')+cb(!a.chlorideOver,'無')+
      '超過容許值含量，若有超過之處理：'+cb(a.chlorideFix==='fix','由委託人修繕後交屋')+'　'+
      cb(a.chlorideFix==='entrust','委託受託人修繕')+'　'+
      cb(a.chlorideFix==='asis','以現況交屋')+'　'+cb(a.chlorideFix==='other','其他')),
    '一、八十三年七月二十一日以前，CNS 3090 未訂定最大水溶性氯離子含量容許值。<br>'+
    '二、八十三年七月二十二日至八十七年六月二十四日申報施工勘驗者，容許值為0.6㎏/m³。<br>'+
    '三、八十七年六月二十五日至一百零四年一月十二日申報施工勘驗者，容許值為0.3㎏/m³。<br>'+
    '四、一百零四年一月十三日（含）以後申報施工勘驗者，容許值為0.15㎏/m³。<br>'+
    '五、上開檢測資料可向建築主管機關申請，不同時期之檢測標準互有差異，'+
    (isBZ?'租賃':'委任')+'雙方應自行注意。']);

  rows.push(['8',
    '本租賃住宅（專有部分）是否曾發生兇殺、自殺、一氧化碳中毒或其他非自然死亡之情事：<br>'+
    (isBZ
      ? '（1）於產權持有期間'+cb(a.deathDuringOwn,'有')+cb(!a.deathDuringOwn,'無')+
        '曾發生上列情事。<br>（2）於產權持有前，出租人：'+
        cb(a.deathBeforeOwn==='none','確認無上列情事')+'　'+
        cb(a.deathBeforeOwn==='known','知道曾發生上列情事')+'　'+
        cb(a.deathBeforeOwn==='unknown','不知道曾否發生上列情事')+'。'
      : '（1）委託人確認租賃住宅所有權人於產權持有期間'+
        cb(a.deathDuringOwn,'有')+cb(!a.deathDuringOwn,'無')+'曾發生上列情事。<br>'+
        '（2）委託人確認租賃住宅所有權人於產權持有前：'+
        cb(a.deathBeforeOwn==='none','無上列情事')+'　'+
        cb(a.deathBeforeOwn==='known','知道曾發生上列情事')+'　'+
        cb(a.deathBeforeOwn==='unknown','不知道曾否發生上列情事')+'。'),
    '']);

  rows.push(['9',
    '供水及排水'+cb(a.waterOk,'是')+cb(!a.waterOk,'否')+'正常。'+
    (isBZ
      ? '若不正常，由'+cb(a.waterFix==='owner','出租人')+cb(a.waterFix==='biz','包租業')+'負責維修。'
      : '若不正常，'+cb(a.waterFix==='fix','由委託人修繕後交屋')+'　'+
        cb(a.waterFix==='entrust','委託受託人修繕')+'　'+
        cb(a.waterFix==='asis','以現況交屋')+'　'+cb(a.waterFix==='other','其他')),
    '']);

  rows.push(['10',
    cb(a.rule,'有')+cb(!a.rule,'無')+'公寓大廈規約或其他住戶應遵行事項；若有，'+
    cb(a.ruleAttached,'有')+cb(!a.ruleAttached,'無')+'檢附規約或其他住戶應遵行事項。','']);

  rows.push(['11',
    cb(a.hasCommittee,'有')+cb(!a.hasCommittee,'無')+'管理委員會統一管理，若有：<br>'+
    '租賃住宅管理費為'+cb(a.mgmtFeeUnit==='月','月繳新臺幣 '+(a.mgmtFee||'　')+' 元')+'　'+
    cb(a.mgmtFeeUnit==='季','季繳')+'　'+cb(a.mgmtFeeUnit==='年','年繳')+'　'+
    cb(a.mgmtFeeUnit==='其他','其他')+'。<br>'+
    '停車位管理費為'+v(a.parkFee||'無',3)+'。<br>'+
    cb(a.owedFee,'有')+cb(!a.owedFee,'無')+'積欠租賃住宅、停車位管理費'+
    (a.owedFee?'，新臺幣'+v(a.owedAmt,4)+'元':'')+'。',
    '停車位管理費以清潔費名義收取者亦同。']);

  const EQUIP=['電視','電視櫃','沙發','茶几','餐桌(椅)','鞋櫃','窗簾','燈飾','冰箱','洗衣機',
    '書櫃','床組(頭)','衣櫃','梳妝台','書桌椅','餐桌椅','置物櫃','電話','保全設施','微波爐',
    '洗碗機','冷氣','排油煙機','流理台','瓦斯爐','熱水器','天然瓦斯'];
  const have={};(a.equip||[]).forEach(x=>have[x[0]]=x[1]);
  rows.push(['12',
    '附屬設備項目如下：<br>'+
    EQUIP.map(n=>cb(have[n]!=null,n+(have[n]!=null?' '+have[n]:' 　'))).join('　')+
    '　'+cb(false,'其他'),'']);

  let h='<div class="paper">';
  h+='<div class="annex-tag">'+(isBZ?'附件一':'附件')+'</div>'+
     '<h2 class="annex-title">'+(isBZ?'租賃標的現況確認書':'委託管理標的現況確認書')+'</h2>'+
     '<div style="text-align:right;font-size:11.5px;margin-bottom:8px">'+
     '填表日期：'+v(rocStr(a.date))+'　契約編號：'+v(d.no)+'</div>';
  h+='<table class="t"><tr><th style="width:5%">項次</th><th style="width:55%">內容</th>'+
     '<th>備註說明</th></tr>'+
     rows.map(r=>'<tr><td class="c">'+r[0]+'</td><td>'+r[1]+
       '</td><td style="font-size:10.5px;color:#444">'+r[2]+'</td></tr>').join('')+
     '</table>';

  h+='<div class="signblock">'+
     '<div class="sigrow">'+
       '<div class="sigcol"><div class="lb">'+(isBZ?'出租人':'委託人（出租人）')+'</div>'+
         '<div class="fl">'+esc(d.owner.name)+'</div>'+
         '<div class="sigbox">'+(d.sign.sigImg?'<img src="'+d.sign.sigImg+'">':'（線上簽名）')+'</div></div>'+
       '<div class="sigcol"><div class="lb">'+(isBZ?'包租業':'受託人（代管業）')+'</div>'+
         '<div class="fl">'+esc(d.biz.name)+'</div><div class="sigbox">（簽章）</div></div>'+
       '<div class="sigcol"><div class="lb">租賃住宅管理人員</div>'+
         '<div class="fl">'+esc(d.mgr.name)+'</div><div class="sigbox">（簽章）</div></div>'+
     '</div>'+
     '<div class="datefoot">簽章日期：'+
       v(rocStr(d.sign.signedAt?d.sign.signedAt.slice(0,10):''))+'</div>'+
     '</div>';
  h+='</div>';
  return h;
}

/* ══════════════════════════════════════════════════════════
   附件二 出租人同意轉租範圍、租賃期間及終止租約事由確認書
   這份是整套設計的關鍵：房東在這裡簽一次，之後每一份轉租契約
   都由系統自動帶入同一份同意書，並可據以檢查
   「轉租的房號與期間有沒有超出房東同意的範圍」。
   ══════════════════════════════════════════════════════════ */
function renderBZ_A2(d){
  const p=d.prop,b=d.bz,t=b.term,s=b.scope;
  let h='<div class="paper">';
  h+='<div class="annex-tag">附件二</div>'+
     '<h2 class="annex-title">出租人同意轉租範圍、租賃期間及終止租約事由確認書</h2>';

  h+='<p style="margin:14px 0">出租人'+v(d.owner.name)+
     '將後列住宅出租予包租業'+v(d.biz.name)+
     '，並於'+v(rocStr(b.signDate))+
     '簽訂住宅包租契約書在案，茲同意包租業得於租賃期間將住宅轉租，'+
     '但包租業應於簽訂轉租契約三十日內，將轉租範圍、期間、'+
     '次承租人之姓名及其通訊地址等相關資料告知本人。'+
     '本人同意轉租範圍及租賃相關事項如附明細表。</p>';

  h+='<p style="margin:18px 0 6px">此致</p>'+
     '<p style="margin:0 0 20px;padding-left:2em">包租業　'+v(d.biz.name)+'</p>';

  h+='<div style="text-align:right;margin:24px 0">'+
     '出租人　'+v(d.owner.name)+'　（簽章）'+
     '<div class="sigbox" style="width:180px;margin-left:auto;margin-top:6px">'+
     (d.sign.sigImg?'<img src="'+d.sign.sigImg+'">':'（線上簽名）')+'</div>'+
     '</div>';

  const r=roc(d.sign.signedAt?d.sign.signedAt.slice(0,10):'');
  h+='<div class="datefoot">中　華　民　國　'+v(r.y,3)+'　年　'+v(r.m,2)+'　月　'+v(r.d,2)+'　日</div>';

  h+='<h2 class="annex-title" style="margin-top:28px;font-size:14px">'+
     '出租人同意轉租範圍、租賃期間及終止租約事由明細表（請逐戶填載）</h2>';
  h+='<table class="t">'+
     '<tr><th colspan="8">租賃住宅標的</th><th style="width:9%">轉租之範圍</th>'+
     '<th style="width:16%">租賃起迄期間</th><th style="width:11%">有無提前終止租約之約定</th>'+
     '<th style="width:12%">備註</th></tr>'+
     '<tr><th>縣市</th><th>鄉鎮市區</th><th>街路</th><th>段</th><th>巷</th><th>弄</th>'+
     '<th>號</th><th>樓</th><th></th><th></th><th></th><th></th></tr>'+
     '<tr>'+
       '<td class="c">'+v(p.city,2)+'</td><td class="c">'+v(p.dist,2)+'</td>'+
       '<td class="c">'+v(p.road,3)+'</td><td class="c">'+v(p.sec,1)+'</td>'+
       '<td class="c">'+v(p.lane,1)+'</td><td class="c">'+v(p.alley,1)+'</td>'+
       '<td class="c">'+v(p.no,1)+'</td><td class="c">'+v(p.floor,1)+'</td>'+
       '<td class="c">'+cb(s.whole,'全部')+'<br>'+cb(!s.whole,'一部')+'</td>'+
       '<td class="c">'+v(rocStr(t.from))+'<br>起至<br>'+v(rocStr(t.to))+'止</td>'+
       '<td class="c">'+cb(b.earlyTerm,'有')+'<br>'+cb(!b.earlyTerm,'無')+'</td>'+
       '<td style="font-size:10.5px">同意轉租範圍如為一部者，應檢附該部分位置示意圖</td>'+
     '</tr>'+
     '</table>';
  h+='<p style="font-size:11.5px;margin-top:10px">'+
     '附註：本住宅包租契約於租賃期間，如有提前終止租約之約定者，'+
     '其提前終止租約之事由如下（即本契約第十三點、第十六點及第十七點所列事由）：</p>'+
     '<div style="border:1px solid #333;min-height:70px;padding:8px;font-size:11.5px">'+
     '依本契約第十三點（雙方約定得提前終止）、第十六點（出租人提前終止之十三款事由）'+
     '及第十七點（包租業提前終止之四款事由）辦理。</div>';
  h+='</div>';
  return h;
}

/* ══════════════════════════════════════════════════════════
   附件三 出租人負擔修繕費用之項目及範圍確認書
   注意與轉租契約附件三的差別：這份多了「租賃期間損壞責任歸屬」
   與「修繕費用之負擔」兩欄，要分別勾，因為包租關係裡
   「誰修」與「誰付錢」可以不是同一方。
   ══════════════════════════════════════════════════════════ */
function renderBZ_A3(d){
  const a=d.bz.a3;
  const GROUPS=[
    ['室外',['大門','門鎖','門鈴','對講機','房門','門口燈','其他']],
    ['客餐廳及臥室',['落地門窗','紗門','玻璃窗','天花板','內牆壁','室內地板','其他']],
    ['廚房及衛浴設備等',['洗臉台','流理台','排水孔','水龍頭','馬桶','浴缸','門窗',
      '天花板','地板','牆壁','其他']]
  ];
  let h='<div class="paper">';
  h+='<div class="annex-tag">附件三</div>'+
     '<h2 class="annex-title">出租人負擔修繕費用之項目及範圍確認書</h2>';

  h+='<p style="margin:14px 0">出租人'+v(d.owner.name)+
     '將住宅出租予包租業'+v(d.biz.name)+
     '，並於'+v(rocStr(d.bz.signDate))+
     '簽訂住宅包租契約書在案，茲同意依本契約第'+v(a.articleRef,2)+'點第'+v(a.paraRef,1)+
     '項約定出具本租賃住宅負擔修繕費用之項目及範圍之確認書如附明細表'+
     '（僅為例示，應由租賃雙方依實際情形自行約定後確認之）。</p>';

  h+='<p style="margin:18px 0 6px">此致</p>'+
     '<p style="margin:0 0 20px;padding-left:2em">包租業　'+v(d.biz.name)+'</p>';

  h+='<div style="text-align:right;margin:24px 0">'+
     '出租人　'+v(d.owner.name)+'　（簽章）'+
     '<div class="sigbox" style="width:180px;margin-left:auto;margin-top:6px">'+
     (d.sign.sigImg?'<img src="'+d.sign.sigImg+'">':'（線上簽名）')+'</div>'+
     '</div>';
  const r=roc(d.sign.signedAt?d.sign.signedAt.slice(0,10):'');
  h+='<div class="datefoot">中　華　民　國　'+v(r.y,3)+'　年　'+v(r.m,2)+'　月　'+v(r.d,2)+'　日</div>';
  h+='</div>';

  h+='<div class="paper">';
  h+='<h2 class="annex-title" style="font-size:15px">出租人負擔修繕費用之項目及範圍明細表</h2>';
  h+='<table class="t"><tr>'+
     '<th style="width:6%"></th><th style="width:18%">設備或設施及數量</th>'+
     '<th style="width:19%">點交狀態</th><th style="width:21%">租賃期間損壞責任歸屬</th>'+
     '<th style="width:21%">修繕費用之負擔</th><th>備註</th></tr>';
  const duty=val=>cb(val==='biz','包租業')+'　'+cb(val==='owner','出租人')+'　'+cb(val==='other','其他');
  GROUPS.forEach(g=>{
    g[1].forEach((item,i)=>{
      h+='<tr>'+
        (i===0?'<td class="g" rowspan="'+g[1].length+'">'+esc(g[0])+'</td>':'')+
        '<td>'+esc(item)+'</td>'+
        '<td class="c">'+cb(a.defaultState==='現狀','現狀')+'　'+
          cb(a.defaultState==='修繕後','修繕後點交')+'</td>'+
        '<td class="c">'+duty(a.defaultDuty)+'</td>'+
        '<td class="c">'+duty(a.defaultCost)+'</td>'+
        '<td></td></tr>';
    });
  });
  h+='<tr><td class="g">其他</td><td colspan="5" style="height:60px"></td></tr>';
  h+='</table>';

  h+='<div style="font-size:11px;line-height:1.8;margin-top:10px">'+
     '<p style="margin:0">附註：</p>'+
     '<p style="margin:0">1. 以上損壞責任歸屬及費用負擔請逐戶填載；'+
       '如附屬設備有不及填載時，得於其他欄填載。</p>'+
     '<p style="margin:0">2. 如為現狀點交者，建議拍照存證。</p>'+
     '<p style="margin:0">3. 如為修繕後點交，亦應載明修繕方式。</p>'+
     '<p style="margin:0">4. 修繕聯絡方式：'+
       cb(a.contactSame,'同本契約第二十三點之出租人及包租業基本資料')+'　'+
       cb(!a.contactSame,'其他聯絡方式：')+(a.contactSame?'':v(a.contactOther,6))+'</p>'+
     '</div>';
  h+='</div>';
  return h;
}
/* ══════════════════════════════════════════════════════════
   契約本文（依內政部應記載事項二十四點）
   ══════════════════════════════════════════════════════════ */
function renderMain(d){
  const t=d.term,rn=d.rent,dp=d.deposit,f=d.fees,p=d.prop,s=d.scope;
  const termDays=days(t.from,t.to);
  let h='<div class="paper">';

  h+='<h1 class="doc-title">住 宅 轉 租 契 約 書</h1>'+
     '<div class="doc-sub">依內政部「住宅轉租定型化契約應記載及不得記載事項」（中華民國113年11月21日修正）訂立</div>'+
     '<div class="doc-no">契約編號：'+v(d.no)+'</div>';

  h+='<p>立契約書人 包租業：'+v(d.biz.name)+'（以下簡稱包租業）、'+
     '承租人：'+v(d.tenant.name)+'（以下簡稱承租人），'+
     '茲為住宅轉租事宜，雙方合意訂立本契約，條款如下：</p>';

  /* 一 契約審閱期 */
  h+='<div class="art"><div class="art-h">第一條　契約審閱期</div><div class="art-b">'+
     '<p>住宅轉租契約（以下簡稱本契約）於'+rocStr(d.review.handedAt)+
     '經承租人攜回審閱'+v(d.review.days,2)+'日（契約審閱期間至少三日）。</p>'+
     '</div></div>';

  /* 二 租賃標的 */
  h+='<div class="art"><div class="art-h">第二條　租賃標的</div><div class="art-b">'+
     '<p>（一）租賃住宅標示：</p>'+
     '<p class="ind1">1、門牌'+v(p.city,3)+'縣(市)'+v(p.dist,3)+'鄉（鎮、市、區）'+
        v(p.road,4)+'街（路）'+v(p.sec,1)+'段'+v(p.lane,1)+'巷'+v(p.alley,1)+'弄'+
        v(p.no,2)+'號'+v(p.floor,1)+'樓'+(p.floorSub?'之'+v(p.floorSub,1):'')+
        '（基地坐落'+v(p.landSec,3)+'段'+v(p.landSubSec,3)+'小段'+v(p.landNo,3)+'地號）。'+
        '無門牌者，其房屋稅籍編號：'+v(p.taxNo,6)+'或其位置略圖。</p>'+
     '<p class="ind1">2、專有部分建號'+v(p.bldgNo,4)+'，權利範圍'+v(p.right,3)+
        '，面積共計'+v(p.areaTotal,4)+'平方公尺。</p>'+
     '<p class="ind2">（1）主建物面積：'+
        p.mainFloors.map(x=>v(x.f,1)+'層'+v(x.a,4)+'平方公尺').join('，')+
        '，共計'+v(p.mainTotal,4)+'平方公尺，用途'+v(p.mainUse,3)+'。</p>'+
     '<p class="ind2">（2）附屬建物用途'+v(p.annexUse,3)+'，面積'+v(p.annexArea,4)+'平方公尺。</p>'+
     '<p class="ind1">3、共有部分建號'+v(p.commonBldgNo,4)+'，權利範圍'+v(p.commonRight,4)+
        '，持分面積'+v(p.commonArea,4)+'平方公尺。</p>'+
     '<p class="ind1">4、車位：'+cb(p.hasParking,'有（汽車停車位 '+(p.carPark||'　')+' 個、機車停車位 '+(p.motoPark||'　')+' 個）')+
        '　'+cb(!p.hasParking,'無')+'。</p>'+
     '<p class="ind1">5、'+cb(p.hasOtherRight,'有')+cb(!p.hasOtherRight,'無')+
        '設定他項權利，若有，權利種類：'+v(p.otherRightType,4)+'。</p>'+
     '<p class="ind1">6、'+cb(p.hasSeizure,'有')+cb(!p.hasSeizure,'無')+'查封登記。</p>'+
     '<p>（二）租賃範圍：</p>'+
     '<p class="ind1">1、租賃住宅'+cb(s.whole,'全部')+'　'+cb(!s.whole,'部分')+
        '：第'+v(s.floor,1)+'層'+cb(true,'房間 '+(s.roomCount||'　')+' 間')+'（房號 '+v(s.roomNo,3)+'）'+
        '，面積'+v(s.area,4)+'平方公尺（如「租賃住宅位置格局示意圖」標註之租賃範圍）。</p>'+
     '<p class="ind1">2、車位（如無則免填）：'+cb(!p.hasParking,'無車位')+'。</p>'+
     '<p class="ind1">3、租賃附屬設備：'+cb(s.hasFurniture,'有')+cb(!s.hasFurniture,'無')+
        '附屬設備，若有，除另有附屬設備清單外，詳如後附租賃標的現況確認書（附件一）。</p>'+
     '<p class="ind1">4、其他：'+v('',6)+'。</p>'+
     '</div></div>';

  /* 三 租賃期間 */
  h+='<div class="art"><div class="art-h">第三條　租賃期間</div><div class="art-b">'+
     '<p>租賃期間自'+rocStr(t.from)+'起至'+rocStr(t.to)+'止'+
     (termDays?'（共 '+v(termDays,3)+' 日）':'')+'。</p>'+
     '<p>租賃期間不得少於三十日，並不得逾包租契約之租賃期間。</p>'+
     '</div></div>';

  /* 四 租金 */
  h+='<div class="art"><div class="art-h">第四條　租金約定及支付</div><div class="art-b">'+
     '<p>承租人每月租金為新臺幣（下同）'+v(money(rn.monthly),5)+'元整，'+
     '每期應繳納'+v(rn.periods,1)+'個月租金，並於每'+
     cb(rn.payUnit==='月','月')+cb(rn.payUnit==='期','期')+v(rn.payDay,2)+
     '日前支付，不得藉任何理由拖延或拒絕；包租業於租賃期間亦不得藉任何理由要求調漲租金。</p>'+
     '<p>租金支付方式：'+cb(rn.method==='cash','現金繳付')+'　'+
     cb(rn.method==='transfer','轉帳繳付')+'：金融機構：'+v(rn.bank,4)+
     '，戶名：'+v(rn.acctName,5)+'，帳號：'+v(rn.acctNo,6)+'。</p>'+
     '</div></div>';

  /* 五 押金 */
  h+='<div class="art"><div class="art-h">第五條　押金約定及返還</div><div class="art-b">'+
     '<p>押金由租賃雙方約定為'+v(dp.months,1)+'個月租金，金額為'+
     v(money(dp.amount),5)+'元整（最高不得超過二個月租金之總額）。'+
     '承租人應於簽訂本契約之同時給付包租業。</p>'+
     '<p>前項押金，除有第十四條第三項、第十五條第四項及第二十條第二項得抵充之情形外，'+
     '包租業應於租期屆滿或租賃契約終止，承租人返還租賃住宅時，'+
     '返還押金或抵充本契約所生債務後之賸餘押金。</p>'+
     '</div></div>';

  /* 六 相關費用 */
  const fw=(k,lbl)=>'<p class="ind1">'+lbl+'：'+
      cb(f[k]==='biz','由包租業負擔')+'　'+cb(f[k]==='tenant','由承租人負擔')+'　'+
      cb(f[k]==='other','其他')+'</p>';
  h+='<div class="art"><div class="art-h">第六條　租賃期間相關費用之支付</div><div class="art-b">'+
     '<p>租賃期間，使用租賃住宅所生之相關費用：</p>'+
     '<p>（一）管理費：'+cb(f.mgmt==='biz','由包租業負擔')+'　'+cb(f.mgmt==='tenant','由承租人負擔')+'</p>'+
     '<p class="ind1">租賃住宅每月'+v(money(f.mgmtRoom),4)+'元整；停車位每月'+v(money(f.mgmtPark),4)+'元整。</p>'+
     '<p class="ind1">租賃期間因不可歸責於雙方當事人之事由，致本費用增加者，'+
        '承租人就增加部分之金額，以負擔百分之十為限；如本費用減少者，承租人負擔減少後之金額。</p>'+
     fw('water','（二）水費')+
     '<p>（三）電費：'+cb(f.elec==='biz','由包租業負擔')+'　'+
        cb(f.elec==='tenant_meter'||f.elec==='tenant_flat','由承租人負擔')+'</p>'+
     '<p class="ind1">'+cb(f.elec==='tenant_meter','以用電度數計費者')+
        '，每度電費不得超過該租賃標的電費單「當期每度平均電價」；'+
        '如公共設施電費未向台灣電力股份有限公司申辦分攤併入租賃標的電費內者，包租業不得額外收取。</p>'+
     '<p class="ind1">'+cb(f.elec==='tenant_flat','非以用電度數計費者')+
        '，包租業所收取之每期電費總金額，不得超過該租賃標的電費單之每期電費總額。</p>'+
     fw('gas','（四）瓦斯費')+
     fw('net','（五）網路費')+
     '<p>（六）其他費用及其支付方式：'+v(f.other,6)+'。</p>'+
     '</div></div>';

  /* 七 稅費 */
  h+='<div class="art"><div class="art-h">第七條　稅費負擔之約定</div><div class="art-b">'+
     '<p>本契約有關稅費，依下列約定辦理：</p>'+
     '<p class="ind1">（一）包租業收取現金者，其銀錢收據應貼用之印花稅票，由包租業負擔。</p>'+
     '<p class="ind1">（二）依營業稅法規定應開立發票報繳之營業稅，由包租業負擔。</p>'+
     '<p class="ind1">（三）其他稅費及其支付方式：'+v(d.tax.other,4)+'。</p>'+
     '<p>本契約租賃雙方'+cb(d.notarize,'同意')+cb(!d.notarize,'不同意')+'辦理公證；'+
     '同意者，公證費及公證代辦費之負擔另行約定。</p>'+
     '</div></div>';

  /* 八 使用限制 */
  h+='<div class="art"><div class="art-h">第八條　使用租賃住宅之限制</div><div class="art-b">'+
     '<p>本租賃住宅係供居住使用，承租人不得變更用途。</p>'+
     '<p>承租人同意遵守公寓大廈規約或其他住戶應遵行事項，不得違法使用、'+
     '存放有爆炸性或易燃性物品，影響公共安全、公共衛生或居住安寧。</p>'+
     '<p>承租人不得將本租賃住宅之全部或一部分轉租，或將租賃權轉讓於他人。</p>'+
     '</div></div>';

  /* 九 修繕 */
  h+='<div class="art"><div class="art-h">第九條　修繕</div><div class="art-b">'+
     '<p>租賃住宅或附屬設備損壞時，應由包租業負責修繕。但其損壞係可歸責於承租人之事由者，不在此限。</p>'+
     '<p>前項由包租業負責修繕者，承租人得定相當期限催告修繕，'+
     '如包租業未於承租人所定相當期限內修繕時，承租人得自行修繕，'+
     '並請求包租業償還其費用或於第四條約定之租金中扣除。</p>'+
     '<p>包租業為修繕租賃住宅所為之必要行為，應於相當期間先期通知，承租人無正當理由不得拒絕。</p>'+
     '<p>前項包租業於修繕期間，致租賃住宅全部或一部不能居住使用者，'+
     '承租人得請求包租業扣除該期間全部或一部之租金。</p>'+
     '</div></div>';

  /* 十 室內裝修 */
  h+='<div class="art"><div class="art-h">第十條　室內裝修</div><div class="art-b">'+
     '<p>承租人有室內裝修之需要，應經包租業同意並依相關法令規定辦理，且不得損害原有建築結構之安全。</p>'+
     '<p>承租人經包租業同意裝修者，其裝修增設部分若有損壞，由承租人負責修繕。</p>'+
     '<p>第一項情形，承租人返還租賃住宅時，'+
     cb(d.decor.restore==='應負責回復原狀','應負責回復原狀')+'　'+
     cb(d.decor.restore==='現況返還','現況返還')+'　'+
     cb(d.decor.restore==='其他','其他')+'。</p>'+
     '</div></div>';

  /* 十一 包租業義務 */
  h+='<div class="art"><div class="art-h">第十一條　包租業之義務及責任</div><div class="art-b">'+
     '<p>本契約租賃期間，包租業之義務及責任如下：</p>'+
     '<p class="ind1">（一）應出示租賃住宅服務業登記證影本，供承租人核對。</p>'+
     '<p class="ind1">（二）應向承租人提供包租契約之出租人（以下簡稱原出租人）同意轉租之書面文件，'+
        '並載明其與原出租人之租賃標的範圍、租賃期間及得終止住宅包租契約之事由。</p>'+
     '<p class="ind1">（三）應以合於所約定居住使用之租賃住宅，交付承租人，並於租賃期間保持其合於居住使用之狀態。</p>'+
     '<p class="ind1">（四）簽訂本契約，應先向承租人說明租賃住宅由包租業負責修繕項目及範圍，'+
        '並提供有修繕必要時之聯絡方式。</p>'+
     '<p class="ind1">（五）應製作租賃標的現況確認書（附件一），並於簽訂本契約時，'+
        '以該確認書及本契約向承租人解說。</p>'+
     '<p class="ind1">（六）應於收受承租人之有關費用或文件時，開立統一發票或掣給收據。</p>'+
     '<p class="ind1">（七）應執行日常修繕維護並製作紀錄，提供承租人查詢或取閱。</p>'+
     '<p class="ind1">（八）原出租人有修繕之必要行為時，包租業應於相當期間先期通知承租人配合辦理。</p>'+
     '<p class="ind1">（九）應配合承租人設立戶籍需要，協助向原出租人取得可供設籍之相關證明。</p>'+
     '<p class="ind1">（十）依第六條規定約定電費由承租人負擔者，包租業應提供承租人租賃標的之電費資訊。'+
        '承租人亦得逕向台灣電力股份有限公司申辦查詢租賃期間之有關電費資訊。</p>'+
     '<p>前項第二款、第四款之同意轉租及負責修繕項目、範圍，'+
     '如附件二「出租人同意轉租範圍、租賃期間及終止租約事由確認書」'+
     '及附件三「包租業負責修繕項目及範圍確認書」。</p>'+
     '</div></div>';

  /* 十二 承租人義務 */
  h+='<div class="art"><div class="art-h">第十二條　承租人之義務及責任</div><div class="art-b">'+
     '<p>承租人應於簽訂本契約時，出示國民身分證或其他足資證明身分之文件，供包租業核對。</p>'+
     '<p>承租人應以善良管理人之注意，保管、使用租賃住宅。</p>'+
     '<p>承租人違反前項義務，致租賃住宅毀損或滅失者，應負損害賠償責任。'+
     '但依約定之方法或依租賃住宅之性質使用，致有變更或毀損者，不在此限。</p>'+
     '</div></div>';

  /* 十三 部分滅失 */
  h+='<div class="art"><div class="art-h">第十三條　租賃住宅部分滅失</div><div class="art-b">'+
     '<p>租賃關係存續中，因不可歸責於承租人之事由，致租賃住宅之一部滅失者，'+
     '承租人得按滅失之部分，請求減少租金。</p>'+
     '</div></div>';

  /* 十四 提前終止 */
  h+='<div class="art"><div class="art-h">第十四條　提前終止租約之約定</div><div class="art-b">'+
     '<p>本契約於期限屆滿前，除第十七條及第十八條規定外，租賃雙方'+
     cb(d.earlyTerm,'得')+cb(!d.earlyTerm,'不得')+'終止租約。</p>'+
     '<p>依約定得終止租約者，租賃之一方應至少於終止前一個月通知他方。'+
     '一方未為先期通知而逕行終止租約者，應賠償他方最高不得超過一個月租金額之違約金。</p>'+
     '<p>前項承租人應賠償之違約金得由第五條第一項規定之押金中抵充。</p>'+
     '<p>租期屆滿前，依第二項規定終止租約者，包租業已預收之租金應返還予承租人。</p>'+
     '</div></div>';

  /* 十五 返還 */
  h+='<div class="art"><div class="art-h">第十五條　租賃住宅之返還</div><div class="art-b">'+
     '<p>租期屆滿或租賃契約終止時，包租業應即結算承租人第六條約定之相關費用，'+
     '並會同承租人共同完成屋況及附屬設備之點交手續，'+
     '承租人應將租賃住宅返還包租業並遷出戶籍或其他登記。</p>'+
     '<p>前項租賃之一方未會同點交，經他方定相當期限催告仍不會同者，視為完成點交。</p>'+
     '<p>承租人未依第一項規定返還租賃住宅時，包租業應明示不以不定期限繼續契約，'+
     '並得向承租人請求未返還租賃住宅期間之相當月租金額，'+
     '及相當月租金額計算之違約金（未足一個月者，以日租金折算）至返還為止。</p>'+
     '<p>前項金額及承租人未繳清第六條約定之相關費用，包租業得由第五條第一項規定之押金中抵充。</p>'+
     '</div></div>';

  /* 十六 所有權讓與 */
  h+='<div class="art"><div class="art-h">第十六條　租賃住宅所有權之讓與</div><div class="art-b">'+
     '<p>本契約租賃期間，租賃住宅所有權人縱將其所有權讓與第三人，'+
     '包租契約對於受讓人仍繼續存在，本契約不因此而受影響。</p>'+
     '<p>前項情形，包租業應於接獲原出租人通知後，以書面通知承租人。</p>'+
     '</div></div>';

  /* 十七 包租業提前終止 */
  h+='<div class="art"><div class="art-h">第十七條　包租業提前終止租約</div><div class="art-b">'+
     '<p>租賃期間有下列情形之一者，包租業得提前終止租約，承租人不得要求任何賠償：</p>'+
     '<p class="ind1">（一）原出租人為重新建築而必要收回。</p>'+
     '<p class="ind1">（二）承租人遲付租金之總額達二個月之金額，經包租業定相當期限催告，仍不為支付。</p>'+
     '<p class="ind1">（三）承租人積欠管理費或其他應負擔之費用達二個月之租金額，經包租業定相當期限催告，仍不為支付。</p>'+
     '<p class="ind1">（四）承租人違反第八條第一項規定，擅自變更用途，經包租業阻止仍繼續為之。</p>'+
     '<p class="ind1">（五）承租人違反第八條第二項規定，違法使用、存放有爆炸性或易燃性物品，經包租業阻止仍繼續為之。</p>'+
     '<p class="ind1">（六）承租人違反第八條第三項規定，擅自將租賃住宅轉租或轉讓租賃權予他人，'+
        '經包租業阻止仍未終止轉租或轉讓契約。</p>'+
     '<p class="ind1">（七）承租人毀損租賃住宅或附屬設備，經包租業定相當期限催告修繕仍不為修繕或相當之賠償。</p>'+
     '<p class="ind1">（八）承租人違反第十條第一項規定，未經包租業同意，擅自進行室內裝修，經包租業阻止仍繼續為之。</p>'+
     '<p class="ind1">（九）承租人違反第十條第一項規定，未依相關法令規定進行室內裝修，經包租業阻止仍繼續為之。</p>'+
     '<p class="ind1">（十）承租人違反第十條第一項規定，進行室內裝修，損害原有建築結構之安全。</p>'+
     '<p>包租業依前項規定提前終止租約者，應依下列規定期限，檢附相關事證，以書面通知承租人：</p>'+
     '<p class="ind1">（一）依前項第一款規定終止者，於終止前三個月。</p>'+
     '<p class="ind1">（二）依前項第二款至第十款規定終止者，於終止前三十日。'+
        '但前項第五款及第十款有公共安全之危害情形者，得不先期通知。</p>'+
     '</div></div>';

  /* 十八 承租人提前終止 */
  h+='<div class="art"><div class="art-h">第十八條　承租人提前終止租約</div><div class="art-b">'+
     '<p>租賃期間有下列情形之一，承租人得提前終止租約，包租業不得要求任何賠償：</p>'+
     '<p class="ind1">（一）租賃住宅未合於居住使用，並有修繕之必要，經承租人依第九條第二項規定催告，仍不於期限內修繕。</p>'+
     '<p class="ind1">（二）租賃住宅因不可歸責於承租人之事由致一部滅失，且其存餘部分不能達租賃之目的。</p>'+
     '<p class="ind1">（三）租賃住宅有危及承租人或其同居人之安全或健康之瑕疵；'+
        '承租人於簽約時已明知該瑕疵或拋棄終止租約權利者，亦同。</p>'+
     '<p class="ind1">（四）承租人因疾病、意外產生有長期療養之需要。</p>'+
     '<p class="ind1">（五）因第三人就租賃住宅主張其權利，致承租人不能為約定之居住使用。</p>'+
     '<p class="ind1">（六）包租業經主管機關撤銷、廢止其許可或登記。</p>'+
     '<p>承租人依前項各款規定提前終止租約者，應於終止前三十日，檢附相關事證，以書面通知包租業。'+
     '但前項第三款前段其情況危急或有第六款之情形者，得不先期通知。</p>'+
     '<p>承租人死亡，其繼承人得主張終止租約，其通知期限及方式，準用前項規定。</p>'+
     '</div></div>';

  /* 十九 提前終止包租契約之處理 */
  h+='<div class="art"><div class="art-h">第十九條　提前終止包租契約之處理</div><div class="art-b">'+
     '<p>包租業應於知悉原出租人提前終止包租契約之次日起五日內通知承租人終止本契約，'+
     '協調返還租賃住宅、執行屋況及附屬設備點交事務、退還預收租金及全部或一部押金，'+
     '並協助承租人優先承租其他租賃住宅。</p>'+
     '<p>前項原出租人提前終止包租契約之情形，於包租業因故停業、解散或他遷不明時，'+
     '得由原出租人通知承租人，承租人並得請求所在地租賃住宅服務商業同業公會'+
     '或其全國聯合會協調續租事宜，該同業公會或其全國聯合會不得拒絕。</p>'+
     '<p>前二項原出租人提前終止包租契約之情形，因可歸責於包租業之事由，'+
     '致承租人受損害時，包租業應負賠償責任。</p>'+
     '</div></div>';

  /* 二十 遺留物 */
  h+='<div class="art"><div class="art-h">第二十條　遺留物之處理</div><div class="art-b">'+
     '<p>本契約租期屆滿或提前終止租約，依第十五條完成點交或視為完成點交之手續後，'+
     '承租人仍於租賃住宅有遺留物者，除租賃雙方另有約定外，'+
     '經包租業定相當期限向承租人催告，逾期仍不取回時，視為拋棄其所有權。</p>'+
     '<p>包租業處理前項遺留物所生費用，得由第五條第一項規定之押金中抵充，'+
     '如有不足，並得向承租人請求給付不足之費用。</p>'+
     '</div></div>';

  /* 二十一 通知 */
  h+='<div class="art"><div class="art-h">第二十一條　履行本契約之通知</div><div class="art-b">'+
     '<p>除本契約另有約定外，租賃雙方相互間之通知，以郵寄為之者，應以本契約所記載之地址為準；'+
     '如因地址變更未告知他方，致通知無法到達時，以第一次郵遞之日期推定為到達日。</p>'+
     '<p>前項之通知得經租賃雙方約定以'+
     cb(d.notice.email,'電子郵件信箱：')+(d.notice.email?v(d.tenant.email,6):'')+'　'+
     cb(d.notice.sms,'手機簡訊')+'　'+
     cb(d.notice.im,'即時通訊軟體以文字顯示方式')+'為之。</p>'+
     '</div></div>';

  /* 二十二 其他約定 */
  h+='<div class="art"><div class="art-h">第二十二條　其他約定</div><div class="art-b">'+
     '<p>本契約租賃雙方'+cb(d.notarize,'同意')+cb(!d.notarize,'不同意')+'辦理公證。</p>'+
     '<p>本契約經辦理公證者，租賃雙方就公證書載明下列事項應逕受強制執行部分，另行勾選約定：'+
     '①承租人如於租期屆滿後不返還租賃住宅；'+
     '②承租人未依約給付之欠繳租金、費用及包租業或租賃住宅所有權人代繳之管理費，或違約時應支付之金額；'+
     '③包租業如於租期屆滿或本契約終止時，應返還承租人之全部或一部押金。</p>'+
     '</div></div>';

  /* 二十三 效力 */
  h+='<div class="art"><div class="art-h">第二十三條　契約及其相關附件效力</div><div class="art-b">'+
     '<p>本契約自簽約日起生效，雙方各執一份契約正本。</p>'+
     '<p>包租業之廣告及相關附件視為本契約之一部分。</p>'+
     '<p>本契約附件如下，均為本契約之一部分：'+
     '附件一 租賃標的現況確認書、'+
     '附件二 出租人同意轉租範圍、租賃期間及終止租約事由確認書、'+
     '附件三 包租業負責修繕項目及範圍確認書。</p>'+
     '</div></div>';

  /* 二十四 當事人基本資料 */
  h+='<div class="art"><div class="art-h">第二十四條　當事人及相關人員基本資料</div><div class="art-b">'+
     '<table class="t">'+
     '<tr><th style="width:15%">承租人</th><td>'+
       '姓名：'+v(d.tenant.name)+'　國民身分證統一編號：'+v(d.tenant.idNo)+'<br>'+
       '戶籍地址：'+v(d.tenant.hukou)+'<br>'+
       '通訊地址：'+v(d.tenant.mail)+'<br>'+
       '聯絡電話：'+v(d.tenant.tel)+'　電子郵件信箱：'+v(d.tenant.email)+
       '</td></tr>'+
     '<tr><th>包租業</th><td>'+
       '公司名稱：'+v(d.biz.name)+'　統一編號：'+v(d.biz.taxid)+'<br>'+
       '代表人姓名：'+v(d.biz.rep)+'　租賃住宅服務業登記證字號：'+v(d.biz.licNo)+'<br>'+
       '營業地址：'+v(d.biz.addr)+'<br>'+
       '聯絡電話：'+v(d.biz.tel)+'　電子郵件信箱：'+v(d.biz.email)+
       '</td></tr>'+
     '<tr><th>租賃住宅<br>管理人員</th><td>'+
       '姓名：'+v(d.mgr.name)+'　證書字號：'+v(d.mgr.certNo)+'<br>'+
       '通訊地址：'+v(d.mgr.addr)+'<br>'+
       '聯絡電話：'+v(d.mgr.tel)+'　電子郵件信箱：'+v(d.mgr.email)+
       '</td></tr>'+
     '</table>'+
     '</div></div>';

  h+=signBlock(d,'包租業','承租人',d.biz.name,d.tenant.name,true);
  h+='</div>';
  return h;
}

/* ══════════════════════════════════════════════════════════
   簽署區（含電子簽署同意、審閱確認、稽核軌跡）
   ══════════════════════════════════════════════════════════ */
function signBlock(d,leftLabel,rightLabel,leftName,rightName,withReview){
  let h='<div class="signblock">';

  if(withReview){
    h+='<p style="font-size:11.5px;line-height:1.75;border:1px solid #333;padding:8px 10px;margin:0 0 12px">'+
       cb(true,'')+'　本人（承租人）確認已於'+v(rocStr(d.review.handedAt))+
       '收到本契約及其全部附件，並已完成'+v(d.review.days,2)+'日以上之審閱。'+
       '本人同意以電子文件及電子簽章方式訂立本契約，'+
       '並瞭解依電子簽章法規定，其效力與親筆簽名相同。'+
       '<br><span style="color:#666">系統紀錄之首次開啟契約時間：'+v(d.sign.openedAt)+'</span>'+
       '</p>';
  }

  h+='<div class="sigrow">'+
     '<div class="sigcol">'+
       '<div class="lb">'+esc(leftLabel)+'</div>'+
       '<div class="fl">'+esc(leftName?leftName:'')+'</div>'+
       '<div class="sigbox">（簽章）</div>'+
     '</div>'+
     '<div class="sigcol">'+
       '<div class="lb">'+esc(rightLabel)+'</div>'+
       '<div class="fl">'+esc(rightName?rightName:'')+'</div>'+
       '<div class="sigbox">'+(d.sign.sigImg?'<img src="'+d.sign.sigImg+'">':'（線上簽名）')+'</div>'+
     '</div>'+
     '</div>';

  h+='<div class="audit"><b>電子簽署稽核紀錄</b>（系統自動產生，不可修改）<br>'+
     '簽署完成時間：'+v(d.sign.signedAt)+'　　簽署來源 IP：'+v(d.sign.ip)+'<br>'+
     '簽署裝置：'+v(d.sign.ua)+'<br>'+
     '契約內容雜湊值：'+v(d.sign.hash)+
     '</div>';

  h+='<div class="datefoot">中　華　民　國　'+v(roc(d.sign.signedAt?d.sign.signedAt.slice(0,10):'').y,3)+
     '　年　'+v(roc(d.sign.signedAt?d.sign.signedAt.slice(0,10):'').m,2)+
     '　月　'+v(roc(d.sign.signedAt?d.sign.signedAt.slice(0,10):'').d,2)+'　日</div>';

  h+='</div>';
  return h;
}

/* ══════════════════════════════════════════════════════════
   附件一 租賃標的現況確認書
   ══════════════════════════════════════════════════════════ */
function renderA1(d){
  const a=d.a1,p=d.prop;
  const rows=[];

  rows.push(['1',
    cb(a.illegal,'有')+cb(!a.illegal,'無')+'包括未登記之改建、增建、加建、違建部分'+
    (a.illegal?'：'+v(a.illegalNote,6):'。'),
    '若為違建（未依法申請增、加建之建物），包租業應確實加以說明，使承租人得以充分認知此範圍之建物隨時有被拆除之虞或其他危險。']);

  rows.push(['2',
    '建物型態：'+v(p.bldgType)+'。<br>建物現況格局：'+
    v(p.layout.room,1)+'房（間、室）'+v(p.layout.hall,1)+'廳'+v(p.layout.bath,1)+'衛　'+
    cb(p.layout.partition,'有')+cb(!p.layout.partition,'無')+'隔間。',
    '一、建物型態：（一）一般建物：單獨所有權無共有部分（包括獨棟、連棟、雙併等）。'+
    '（二）區分所有建物：公寓（五樓含以下無電梯）、透天厝、店面（店鋪）、辦公商業大樓、'+
    '住宅或複合型大樓（十一層含以上有電梯）、華廈（十層含以下有電梯）、套房（一房、一廳、一衛）等。'+
    '（三）其他特殊建物：如工廠、廠辦、農舍、倉庫等型態。<br>'+
    '二、現況格局（例如：房間、廳、衛浴數，有無隔間）。']);

  rows.push(['3',
    cb(a.hasParkingDetail,'有')+cb(!a.hasParkingDetail,'無')+'汽車停車位。'+
    '汽車停車位種類及編號：地上（下）第'+v('',1)+'層'+cb(false,'平面式停車位')+cb(false,'機械式停車位')+
    '，編號第'+v('',1)+'號車位'+v('',1)+'個，'+cb(false,'有')+cb(true,'無')+'獨立權狀。<br>'+
    '機車停車位：地上（下）第'+v('',1)+'層，編號第'+v('',1)+'號車位'+v('',1)+'個或其位置示意圖。',
    '']);

  rows.push(['4',
    cb(a.fireAlarm,'有')+cb(!a.fireAlarm,'無')+'住宅用火災警報器。<br>'+
    cb(a.otherFire,'有')+cb(!a.otherFire,'無')+'其他消防設施，若有，項目：'+
    v((a.otherFireItems||[]).join('、'),6)+'。<br>'+
    cb(a.fireCheck,'有')+cb(!a.fireCheck,'無')+'定期辦理消防安全檢查。',
    '非屬應設置火警自動警報設備之住宅所有權人應依消防法第六條第五項規定設置及維護住宅用火災警報器。']);

  rows.push(['5',
    cb(a.leak,'有')+cb(!a.leak,'無')+'滲漏水之情形'+(a.leak?'，滲漏水處：'+v(a.leakWhere,4):'')+'。<br>'+
    '若有滲漏水處之處理：'+cb(a.leakFix==='fix','由包租業修繕後交屋')+'　'+
    cb(a.leakFix==='asis','以現況交屋')+'　'+cb(a.leakFix==='other','其他'),
    '']);

  rows.push(['6',
    cb(a.radiation,'有')+cb(!a.radiation,'無')+'曾經做過輻射屋檢測？若有，請檢附檢測證明文件。<br>'+
    '檢測結果是否有輻射異常？'+cb(a.radiationResult==='yes','是')+cb(a.radiationResult!=='yes','否')+'。',
    '七十一年至七十三年領得使用執照之建築物，應特別留意檢測。如欲進行改善，應向核能安全委員會洽詢技術協助。']);

  rows.push(['7',
    cb(a.chloride,'有')+cb(!a.chloride,'無')+
    '曾經做過混凝土中水溶性氯離子含量檢測（例如海砂屋檢測事項）；'+
    '若有，檢測結果：'+v(a.chlorideResult,6)+'。',
    '一、八十四年六月三十日以前已建築完成之建築物，參照CNS 3090檢測標準，'+
    '混凝土中最大水溶性氯離子含量（依水溶法）容許值為0.6㎏/m³。<br>'+
    '二、八十四年七月一日至一百零四年一月十二日依建築法規申報施工勘驗之建築物，容許值為0.3㎏/m³。<br>'+
    '三、一百零四年一月十三日（含）以後依建築法規申報施工勘驗之建築物，容許值為0.15㎏/m³。<br>'+
    '四、上開檢測資料可向建築主管機關申請，不同時期之檢測值互有差異，租賃雙方應自行注意。']);

  rows.push(['8',
    '本租賃住宅（專有部分）是否曾發生兇殺、自殺、一氧化碳中毒或其他非自然死亡之情事：<br>'+
    '（1）包租業確認原出租人於產權持有期間'+cb(a.deathDuringOwn,'有')+cb(!a.deathDuringOwn,'無')+'曾發生上列情事。<br>'+
    '（2）於產權持有前，包租業確認原出租人：'+
    cb(a.deathBeforeOwn==='none','無上列情事')+'　'+
    cb(a.deathBeforeOwn==='known','知道曾發生上列情事')+'　'+
    cb(a.deathBeforeOwn==='unknown','不知道曾否發生上列情事')+'。',
    '']);

  rows.push(['9',
    '供水及排水'+cb(a.waterOk,'是')+cb(!a.waterOk,'否')+'正常。'+
    '若不正常，由'+cb(a.waterFixBy==='biz','包租業')+cb(a.waterFixBy==='tenant','承租人')+'負責維修。',
    '']);

  rows.push(['10',
    cb(a.rule,'有')+cb(!a.rule,'無')+'公寓大廈規約或其他住戶應遵行事項；'+
    '若有，'+cb(a.ruleAttached,'有')+cb(!a.ruleAttached,'無')+'檢附規約或其他住戶應遵行事項。',
    '']);

  rows.push(['11',
    cb(a.hasCommittee,'有')+cb(!a.hasCommittee,'無')+'管理委員會統一管理，若有：<br>'+
    '租賃住宅管理費為'+cb(a.mgmtFeeUnit==='月','月繳新臺幣 '+(a.mgmtFee||'　')+' 元')+'　'+
    cb(a.mgmtFeeUnit==='季','季繳')+'　'+cb(a.mgmtFeeUnit==='年','年繳')+'。<br>'+
    '停車位管理費為'+v(a.parkFee||'無',3)+'。<br>'+
    cb(a.owedFee,'有')+cb(!a.owedFee,'無')+'積欠租賃住宅、停車位管理費；'+
    (a.owedFee?'若有，新臺幣'+v(a.owedAmt,4)+'元。':''),
    '停車位管理費以清潔費名義收取者亦同。']);

  const EQUIP=['電視','電視櫃','沙發','茶几','餐桌(椅)','鞋櫃','窗簾','燈飾','冰箱','洗衣機',
    '書櫃','床組(頭)','衣櫃','梳妝台','書桌椅','餐桌椅','置物櫃','電話','保全設施','微波爐',
    '洗碗機','冷氣','排油煙機','流理台','瓦斯爐','熱水器','天然瓦斯'];
  const have={};(a.equip||[]).forEach(x=>have[x[0]]=x[1]);
  rows.push(['12',
    '附屬設備項目如下：<br>'+
    EQUIP.map(n=>cb(have[n]!=null,n+(have[n]!=null?' '+have[n]:' 　'))).join('　')+
    '　'+cb(false,'其他'),
    '']);

  let h='<div class="paper">';
  h+='<div class="annex-tag">附件一</div>'+
     '<h2 class="annex-title">租賃標的現況確認書</h2>'+
     '<div style="text-align:right;font-size:11.5px;margin-bottom:8px">'+
     '填表日期：'+v(rocStr(a.date))+'　契約編號：'+v(d.no)+'</div>';
  h+='<table class="t"><tr><th style="width:5%">項次</th><th style="width:55%">內容</th><th>備註說明</th></tr>'+
     rows.map(r=>'<tr><td class="c">'+r[0]+'</td><td>'+r[1]+'</td><td style="font-size:10.5px;color:#444">'+r[2]+'</td></tr>').join('')+
     '</table>';

  h+='<div class="signblock">'+
     '<div class="sigrow">'+
       '<div class="sigcol"><div class="lb">包租業</div><div class="fl">'+esc(d.biz.name)+'</div><div class="sigbox">（簽章）</div></div>'+
       '<div class="sigcol"><div class="lb">租賃住宅管理人員</div><div class="fl">'+esc(d.mgr.name)+'</div><div class="sigbox">（簽章）</div></div>'+
       '<div class="sigcol"><div class="lb">承租人</div><div class="fl">'+esc(d.tenant.name)+'</div>'+
         '<div class="sigbox">'+(d.sign.sigImg?'<img src="'+d.sign.sigImg+'">':'（線上簽名）')+'</div></div>'+
     '</div>'+
     '<div class="datefoot">簽章日期：'+v(rocStr(d.sign.signedAt?d.sign.signedAt.slice(0,10):''))+'</div>'+
     '</div>';
  h+='</div>';
  return h;
}

/* ══════════════════════════════════════════════════════════
   附件二 出租人同意轉租範圍、租賃期間及終止租約事由確認書
   由房東在「住宅包租契約」流程中簽署，轉租契約自動帶入。
   ══════════════════════════════════════════════════════════ */
function renderA2(d){
  const p=d.prop,t=d.term,s=d.scope;
  let h='<div class="paper">';
  h+='<div class="annex-tag">附件二</div>'+
     '<h2 class="annex-title">出租人同意轉租範圍、租賃期間及終止租約事由確認書</h2>';

  h+='<p style="margin:14px 0">出租人'+v(d.owner.name)+
     '將後列住宅出租予包租業'+v(d.biz.name)+
     '，並於'+v(rocStr(d.owner.signDate))+
     '簽訂住宅包租契約書在案，茲同意包租業得於租賃期間將住宅轉租，'+
     '但包租業應於簽訂轉租契約三十日內，將轉租範圍、期間及承租人之姓名、通訊住址等相關資料告知本人。'+
     '本人同意轉租範圍及租賃相關事項如附明細表。</p>';

  h+='<p style="margin:18px 0 6px">此致</p>'+
     '<p style="margin:0 0 20px;padding-left:2em">包租業　'+v(d.biz.name)+'</p>';

  h+='<div style="text-align:right;margin:24px 0">'+
     '出租人　'+v(d.owner.name)+'　（簽章）'+
     '<div class="sigbox" style="width:180px;margin-left:auto;margin-top:6px">（簽章）</div>'+
     '</div>';

  h+='<div class="datefoot">中　華　民　國　'+v('',3)+'　年　'+v('',2)+'　月　'+v('',2)+'　日</div>';

  h+='<h2 class="annex-title" style="margin-top:28px;font-size:14px">'+
     '出租人同意轉租範圍、租賃期間及終止租約事由明細表（請逐戶填載）</h2>';
  h+='<table class="t">'+
     '<tr><th colspan="8">租賃住宅標的</th><th style="width:9%">轉租之範圍</th>'+
     '<th style="width:16%">租賃起迄期間</th><th style="width:11%">有無提前終止租約之約定</th><th style="width:12%">備註</th></tr>'+
     '<tr><th>縣市</th><th>鄉鎮市區</th><th>街路</th><th>段</th><th>巷</th><th>弄</th><th>號</th><th>樓</th>'+
     '<th></th><th></th><th></th><th></th></tr>'+
     '<tr>'+
       '<td class="c">'+v(p.city,2)+'</td><td class="c">'+v(p.dist,2)+'</td><td class="c">'+v(p.road,3)+'</td>'+
       '<td class="c">'+v(p.sec,1)+'</td><td class="c">'+v(p.lane,1)+'</td><td class="c">'+v(p.alley,1)+'</td>'+
       '<td class="c">'+v(p.no,1)+'</td><td class="c">'+v(p.floor,1)+'</td>'+
       '<td class="c">'+cb(s.whole,'全部')+'<br>'+cb(!s.whole,'一部')+'</td>'+
       '<td class="c">'+v(rocStr(t.from))+'<br>起至<br>'+v(rocStr(t.to))+'止</td>'+
       '<td class="c">'+cb(d.earlyTerm,'有')+'<br>'+cb(!d.earlyTerm,'無')+'</td>'+
       '<td style="font-size:10.5px">同意轉租範圍如為一部者，應檢附該部分位置示意圖</td>'+
     '</tr>'+
     '</table>';
  h+='<p style="font-size:11.5px;margin-top:10px">'+
     '附註：本住宅包租契約於租賃期間，如有提前終止租約之約定者，其提前終止租約之事由如下：</p>'+
     '<div style="border:1px solid #333;min-height:70px;padding:8px">'+v('',20)+'</div>';
  h+='</div>';
  return h;
}

/* ══════════════════════════════════════════════════════════
   附件三 包租業負責修繕項目及範圍確認書
   ══════════════════════════════════════════════════════════ */
function renderA3(d){
  const a=d.a3;
  const GROUPS=[
    ['室外',['大門','門鎖','門鈴','對講機','房門','門口燈','其他']],
    ['客餐廳及臥室',['落地門窗','紗門','玻璃窗','天花板','內牆壁','室內地板','其他']],
    ['廚房及衛浴設備等',['洗臉台','流理台','排水孔','水龍頭','馬桶','浴缸','門窗','天花板','地板','牆壁','其他']]
  ];
  let h='<div class="paper">';
  h+='<div class="annex-tag">附件三</div>'+
     '<h2 class="annex-title">包租業負責修繕項目及範圍確認書</h2>';

  h+='<p style="margin:14px 0">包租業'+v(d.biz.name)+
     '將住宅出租予承租人'+v(d.tenant.name)+
     '，並於'+v(rocStr(a.contractDate))+
     '簽訂住宅轉租契約書在案，茲同意依本契約第'+v(a.articleRef,2)+
     '條約定出具本租賃住宅負責修繕項目及範圍之確認書如附明細表'+
     '（僅為例示，應由租賃雙方依實際情形自行約定後確認之）。</p>';

  h+='<p style="margin:18px 0 6px">此致</p>'+
     '<p style="margin:0 0 20px;padding-left:2em">承租人　'+v(d.tenant.name)+'</p>';

  h+='<div style="text-align:right;margin:20px 0">'+
     '包租業　'+v(d.biz.name)+
     '<div class="sigbox" style="width:180px;margin-left:auto;margin-top:6px">（簽章）</div>'+
     '</div>';
  h+='<div class="datefoot">中　華　民　國　'+v('',3)+'　年　'+v('',2)+'　月　'+v('',2)+'　日</div>';
  h+='</div>';

  h+='<div class="paper">';
  h+='<h2 class="annex-title" style="font-size:15px">包租業負責修繕項目及範圍明細表</h2>';
  h+='<table class="t"><tr>'+
     '<th style="width:6%"></th><th style="width:20%">設備或設施及數量</th>'+
     '<th style="width:24%">點交狀態</th><th style="width:26%">租賃期間損壞之修繕責任</th><th>備註</th></tr>';
  GROUPS.forEach(g=>{
    g[1].forEach((item,i)=>{
      h+='<tr>'+
        (i===0?'<td class="g" rowspan="'+g[1].length+'">'+esc(g[0])+'</td>':'')+
        '<td>'+esc(item)+'</td>'+
        '<td class="c">'+cb(a.defaultState==='現狀','現狀')+'　'+cb(a.defaultState==='修繕後','修繕後點交')+'</td>'+
        '<td class="c">'+cb(a.defaultFix,'有')+'　'+cb(!a.defaultFix,'無')+'</td>'+
        '<td></td>'+
        '</tr>';
    });
  });
  h+='<tr><td class="g">其他</td><td colspan="4" style="height:60px"></td></tr>';
  h+='</table>';

  h+='<div style="font-size:11px;line-height:1.8;margin-top:10px">'+
     '<p style="margin:0">附註：</p>'+
     '<p style="margin:0">1. 以上修繕項目及範圍請逐戶填載；如附屬設備有不及填載時，得於其他欄填載。</p>'+
     '<p style="margin:0">2. 未經約定確認之設備或設施，除其損壞係可歸責於承租人之事由外，由包租業負責修繕。</p>'+
     '<p style="margin:0">3. 如為現狀點交者，建議拍照存證。</p>'+
     '<p style="margin:0">4. 如為修繕後點交，亦應載明修繕方式。</p>'+
     '<p style="margin:0">5. 修繕聯絡方式：'+
       cb(a.contactSame,'同本契約第二十四條包租業基本資料')+'　'+
       cb(!a.contactSame,'其他聯絡方式：')+(a.contactSame?'':v(a.contactOther,6))+'</p>'+
     '</div>';
  h+='</div>';
  return h;
}

/* ══════════════════════════════════════════════════════════
   可產出的文件清單
   ══════════════════════════════════════════════════════════ */
var DOCS={
  sub:[['all','全部（契約本文＋附件一二三）'],
       ['main','僅契約本文（二十四點）'],
       ['a1','僅附件一 租賃住宅現況確認書'],
       ['a2','僅附件二 出租人同意轉租範圍確認書'],
       ['a3','僅附件三 修繕費用之項目及範圍確認書']],
  bz:[['all','全部（契約本文＋附件一二三）'],
      ['main','僅契約本文（二十三點）'],
      ['a1','僅附件一 租賃住宅標的現況確認書'],
      ['a2','僅附件二 出租人同意轉租範圍確認書'],
      ['a3','僅附件三 出租人負擔修繕費用之項目及範圍確認書']],
  wg:[['all','全部（契約本文＋附件）'],
      ['main','僅契約本文（十五點）'],
      ['a1','僅附件 委託管理標的現況確認書']]
};

var KIND_LABEL={sub:'住宅轉租契約',bz:'住宅包租契約',wg:'租賃住宅委託管理契約'};
var KIND_SIGNER={sub:'房客（次承租人）',bz:'房東（出租人）',wg:'房東（委託人）'};
/* 審閱期：轉租與委管是定型化契約、相對人是消費者，法定至少三日；
   包租契約的相對人是房東，不是消費者，母法沒有審閱期規定。 */
var REVIEW_DAYS={sub:3,bz:0,wg:3};

/* ══════════════════════════════════════════════════════════
   空白資料（所有簽約主體一律留白）
   不同業者用同一份條文、但主體資訊不同，所以模板本身不帶任何
   公司名稱。欄位是空字串時 v() 會自動輸出可手寫的底線格。
   ══════════════════════════════════════════════════════════ */
function blankData(kind){
  return {
    kind:kind||'sub', no:'',
    biz :{name:'',rep:'',taxid:'',licNo:'',addr:'',tel:'',email:''},
    mgr :{name:'',certNo:'',addr:'',tel:'',email:''},
    owner:{name:'',idNo:'',hukou:'',mail:'',tel:'',email:'',signDate:''},
    tenant:{name:'',idNo:'',hukou:'',mail:'',tel:'',email:''},
    prop:{city:'',dist:'',road:'',sec:'',lane:'',alley:'',no:'',floor:'',floorSub:'',
          landSec:'',landSubSec:'',landNo:'',taxNo:'',
          bldgNo:'',right:'',areaTotal:'',
          mainFloors:[],mainTotal:'',mainUse:'',annexUse:'',annexArea:'',
          commonBldgNo:'',commonRight:'',commonArea:'',
          hasParking:false,carPark:'',motoPark:'',
          hasOtherRight:false,otherRightType:'',hasSeizure:false,
          bldgType:'',layout:{room:'',hall:'',bath:'',partition:false}},
    a1:{date:'',illegal:false,illegalNote:'',hasParkingDetail:false,
        fireAlarm:false,otherFire:false,otherFireItems:[],fireCheck:false,
        leak:false,leakWhere:'',leakFix:'',
        radiation:false,radiationResult:'',radiationFix:'',
        chloride:false,chlorideResult:'',chlorideOver:'',chlorideFix:'',
        deathDuringOwn:false,deathBeforeOwn:'',waterOk:false,waterFix:'',waterFixBy:'',
        rule:false,ruleAttached:false,
        hasCommittee:false,mgmtFee:'',mgmtFeeUnit:'',parkFee:'',owedFee:false,owedAmt:'',
        equip:[]},
    /* 住宅轉租契約的條件 */
    sub:{scope:{whole:false,floor:'',roomCount:'',roomNo:'',area:'',hasFurniture:false},
         term:{from:'',to:''},
         rent:{monthly:'',periods:'1',payUnit:'月',payDay:'',method:'transfer',
               bank:'',acctName:'',acctNo:''},
         deposit:{months:'',amount:''},
         fees:{mgmt:'',mgmtRoom:'',mgmtPark:'',water:'',elec:'',gas:'',net:'',other:''},
         tax:{other:''},notarize:false,useLimit:{},decor:{restore:''},earlyTerm:true,
         notice:{email:true,sms:true,im:false},
         review:{handedAt:'',days:3},
         a3:{articleRef:'九',contractDate:'',defaultState:'現狀',defaultFix:true,
             contactSame:true,contactOther:''}},
    /* 住宅包租契約的條件 */
    bz:{scope:{whole:false,floor:'',roomCount:'',roomNo:'',area:'',hasFurniture:false},
        term:{from:'',to:''},
        rent:{monthly:'',periods:'1',payUnit:'月',payDay:'',method:'transfer',
              bank:'',acctName:'',acctNo:''},
        deposit:{months:'',amount:''},
        fees:{mgmt:'',mgmtRoom:'',mgmtPark:'',water:'',elec:'',gas:'',net:'',other:''},
        taxOther:'',notarize:false,otherUse:'',
        decorAllow:true,decorCostBy:'biz',decorRestore:'',earlyTerm:true,
        notice:{email:true,sms:true,im:false},signDate:'',
        a3:{articleRef:'十',paraRef:'二',defaultState:'現狀',defaultDuty:'biz',
            defaultCost:'biz',contactSame:true,contactOther:''}},
    /* 租賃住宅委託管理契約的條件 */
    wg:{scope:{whole:false,floor:'',roomCount:'',roomNo:'',area:'',hasFurniture:false},
        term:{from:'',to:''},
        fee:{mode:'pct',pct:'',amount:'',payUnit:'月',periods:'',payDay:'',method:'deduct',
             bank:'',acctName:'',acctNo:''},
        opt:{collectRent:false,rentDeliver:'',collectDeposit:false,depositDeliver:'',
             manageDeposit:false,advance:false,clean:false,leftover:false,
             furniture:false,other:''},
        dunDays:'',deliverDays:'',
        notice:{email:true,sms:true,im:false},
        review:{handedAt:'',days:3},signDate:''},
    sign:{openedAt:'',signedAt:'',ip:'',ua:'',hash:'',sigImg:''}
  };
}

/* ══════════════════════════════════════════════════════════
   產出 HTML
   ══════════════════════════════════════════════════════════ */
function render(kind,which,data){
  var d=data||blankData(kind);
  which=which||'all';
  if(kind==='sub'){
    /* renderMain / renderA1..A3 讀的是攤平後的欄位 */
    var f={},k; for(k in d) f[k]=d[k];
    var s=d.sub||{}; for(k in s) f[k]=s[k];
    if(which==='all') return renderMain(f)+renderA1(f)+renderA2(f)+renderA3(f);
    if(which==='main')return renderMain(f);
    if(which==='a1')  return renderA1(f);
    if(which==='a2')  return renderA2(f);
    if(which==='a3')  return renderA3(f);
    return '';
  }
  if(kind==='bz'){
    if(which==='all') return renderBZ(d)+renderStatus(d,'bz')+renderBZ_A2(d)+renderBZ_A3(d);
    if(which==='main')return renderBZ(d);
    if(which==='a1')  return renderStatus(d,'bz');
    if(which==='a2')  return renderBZ_A2(d);
    if(which==='a3')  return renderBZ_A3(d);
    return '';
  }
  if(kind==='wg'){
    if(which==='all') return renderWG(d)+renderStatus(d,'wg');
    if(which==='main')return renderWG(d);
    if(which==='a1')  return renderStatus(d,'wg');
    return '';
  }
  return '';
}

/* ══════════════════════════════════════════════════════════
   產生契約前的完整性檢查
   「租賃住宅服務業登記證字號」與「租賃住宅管理人員姓名／證書
   字號」是三份契約的法定必載事項，缺了契約有被認定不合法的風
   險，所以這兩組缺任一項就不讓產生契約（blocking）。
   建物登記資料（建號、面積、地段）代管案件的謄本通常在房東手
   上，拿不到也還是要能簽約，所以只提醒不阻擋（warning）。
   ══════════════════════════════════════════════════════════ */
function validate(kind,d){
  var errs=[],warns=[];
  var biz=d.biz||{},mgr=d.mgr||{},p=d.prop||{};
  function need(val,msg,bucket){ if(!String(val||'').trim()) bucket.push(msg); }

  need(biz.name,'簽約主體設定：公司（商號）名稱未填',errs);
  need(biz.rep,'簽約主體設定：負責人未填',errs);
  need(biz.taxid,'簽約主體設定：統一編號未填',errs);
  need(biz.licNo,'簽約主體設定：租賃住宅服務業登記證字號未填（法定必載）',errs);
  need(biz.addr,'簽約主體設定：公司地址未填',errs);
  need(biz.tel,'簽約主體設定：公司電話未填',errs);
  need(mgr.name,'簽約主體設定：租賃住宅管理人員姓名未填（法定必載）',errs);
  need(mgr.certNo,'簽約主體設定：管理人員證書字號未填（法定必載）',errs);

  need(p.city,'物件所在縣市未填',errs);
  need(p.dist,'物件所在鄉鎮市區未填',errs);
  need(p.road,'物件路街名未填',errs);

  if(kind==='sub'){
    var t=d.tenant||{},s=d.sub||{};
    need(t.name,'房客姓名未填',errs);
    need((s.term||{}).from,'租期起日未填',errs);
    need((s.term||{}).to,'租期迄日未填',errs);
    need((s.rent||{}).monthly,'每月租金未填',errs);
    var nd=days((s.term||{}).from,(s.term||{}).to);
    if(nd&&nd<30) errs.push('租期僅 '+nd+' 日，母法第三點規定不得少於三十日');
    var dep=Number((s.deposit||{}).amount||0),rent=Number((s.rent||{}).monthly||0);
    if(rent&&dep>rent*2) errs.push('押金 '+dep+' 元已超過二個月租金總額 '+(rent*2)+' 元');
    need((s.review||{}).handedAt,'契約審閱起算日未填（法定審閱期至少三日）',warns);
  }
  if(kind==='bz'){
    var o=d.owner||{},bz=d.bz||{};
    need(o.name,'房東（出租人）姓名未填',errs);
    need((bz.term||{}).from,'包租期間起日未填',errs);
    need((bz.term||{}).to,'包租期間迄日未填',errs);
    need((bz.rent||{}).monthly,'每月租金未填',errs);
    var nd2=days((bz.term||{}).from,(bz.term||{}).to);
    if(nd2&&nd2<30) errs.push('包租期間僅 '+nd2+' 日，不得少於三十日');
    var dep2=Number((bz.deposit||{}).amount||0),rent2=Number((bz.rent||{}).monthly||0);
    if(rent2&&dep2>rent2*2) errs.push('押金已超過二個月租金總額');
  }
  if(kind==='wg'){
    var o2=d.owner||{},wg=d.wg||{};
    need(o2.name,'房東（委託人）姓名未填',errs);
    need((wg.term||{}).from,'委託管理期間起日未填',errs);
    need((wg.term||{}).to,'委託管理期間迄日未填',errs);
    var fe=wg.fee||{};
    if(fe.mode==='pct') need(fe.pct,'報酬百分比未填',errs);
    else need(fe.amount,'報酬金額未填',errs);
    need((wg.review||{}).handedAt,'契約審閱起算日未填（法定審閱期至少三日）',warns);
  }

  need(p.bldgNo,'建物建號未填（謄本資料，可留白由房東手寫）',warns);
  need(p.areaTotal,'建物總面積未填（謄本資料，可留白由房東手寫）',warns);
  need(p.landNo,'土地地號未填（謄本資料，可留白由房東手寫）',warns);
  return {ok:errs.length===0,errors:errs,warnings:warns};
}

var API={DOCS:DOCS,KIND_LABEL:KIND_LABEL,KIND_SIGNER:KIND_SIGNER,
         REVIEW_DAYS:REVIEW_DAYS,blankData:blankData,render:render,
         validate:validate,days:days,maskId:maskId,rocStr:rocStr,addrOf:addrOf};
root.ContractRender=API;
if(typeof module!=='undefined'&&module.exports) module.exports=API;
})(typeof window!=='undefined'?window:globalThis);
