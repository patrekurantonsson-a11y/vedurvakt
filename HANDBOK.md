# Veðurvakt

Veðurspá sem sér um sig sjálf. Hún fylgist með opnum mæligögnum Vegagerðarinnar,
les úr þeim hvað andrúmsloftið er að gera í kringum Þorlákshöfn, gefur út spá á
tuttugu mínútna fresti og ber sig svo saman við það sem raunverulega gerðist.

Sami kóði keyrir á tvennan hátt:

- **Á Macnum þínum** — ein Python-skrá, ekkert utanaðkomandi bókasafn, mælaborð á
  `localhost:8787`.
- **Á GitHub Pages** — opinn hlekkur sem þú getur deilt, uppfærður sjálfkrafa af
  tímasettu GitHub Action. Ókeypis, enginn netþjónn.

---

## Að birta hlekkinn

Vefsíðan er kyrrstæð og les eina JSON-skrá. GitHub Action sækir gögnin, reiknar
spána, skrifar JSON-skrána og birtir síðuna.

Ein skipun sér um allt saman, bæði í fyrsta skipti og eftir hverja breytingu:

```bash
cd ~/vedurvakt
./uppfaera.sh                     # eða: ./uppfaera.sh "hvað breyttist"
```

Í fyrsta skipti skráir hún þig inn á GitHub ef þarf, stofnar geymsluna, kveikir
á GitHub Pages og prentar hlekkinn. Ef eitthvað liggur þegar á GitHub sem er ekki
til í möppunni — til dæmis eftir að skrárnar voru teknar upp á nýtt annars staðar
— stöðvast hún og segir frá; þá lætur `./uppfaera.sh --yfirskrifa` þessa möppu
gilda. Eftir það sendir hún einfaldlega það sem
breyttist og ræsir uppfærslu. Eina sem þarf að vera til staðar er `gh`:

```bash
brew install gh
```

Hlekkurinn er `https://NOTANDANAFN.github.io/vedurvakt/` og síðan uppfærir sig
sjálf á tuttugu mínútna fresti eftir það.

Ef þú vilt heldur gera þetta í höndunum: `git init -b main`, `git add .`,
`git commit -m "Veðurvakt"`, `git remote add origin …`, `git push -u origin main`,
og svo **Settings → Pages → Source: GitHub Actions** á github.com.

Tvennt er vert að vita um tímasetninguna. GitHub keyrir tímasett verk oft
nokkrum mínútum of seint þegar álagið er mikið, svo mælingarnar á síðunni geta
verið allt að hálftíma gamlar — síðan segir frá því þegar svo er. Og GitHub
slekkur á tímasettum keyrslum í geymslum sem hafa legið óhreyfðar í 60 daga; ef
síðan staðnar, opnaðu Actions og ýttu á Run workflow til að vekja hana.

Mælingasagan er geymd í skyndiminni Actions en ekki í geymslunni sjálfri, svo
hún helst lítil sama hversu lengi appið keyrir.

## Að keyra á Macnum

```bash
python3 vedurvakt.py run
```

Mælaborðið er á <http://localhost:8787> og mælingar eru sóttar á tíu mínútna
fresti. Aðrar skipanir:

```bash
python3 vedurvakt.py collect     # ein mæling frá öllum stöðvum í gagnagrunninn
python3 vedurvakt.py forecast    # prenta spána í skjáinn
python3 vedurvakt.py build       # skrifa site/data/latest.json (það sem CI gerir)
python3 vedurvakt.py verify      # hversu nákvæmar hafa spárnar verið?
python3 vedurvakt.py config      # skoða eða breyta stillingum
```

`./install.sh` skráir launchd-þjónustu svo appið ræsist við innskráningu og fari
aftur í gang ef það stöðvast. Til að fjarlægja hana:
`launchctl unload ~/Library/LaunchAgents/is.vedurvakt.agent.plist`.

## Hvernig spáin verður til

**Mælingar.** Allar ~200 veðurstöðvar Vegagerðarinnar af
`gagnaveita.vegagerdin.is`, ásamt ölduduflinu við Þorlákshöfn frá Sjólagi, inn í
SQLite-gagnagrunn á `~/.vedurvakt/vedurvakt.db`.

**Greining.** Út úr hverri mælingu:

- *Þrýstisvið* — plan er fellt að sjávarmálsþrýstingi allra stöðva með loftvog
  með aðferð minnstu kvaðrata, og verstu 15% leifanna eru skorin burt því
  ókvarðaðar loftvogir eru algengar í þessu neti. Hallinn gefur þrýstivindinn.
- *Sólskin* — skynjarar í vegyfirborði standa við hliðina á lofthitamælum. Þegar
  malbikið er nokkrum gráðum hlýrra en loftið skín sólin á það. Efri fjórðungur
  þess mismunar, vegið eftir sólarhæð, gefur mat á skýjahulu sem ekkert
  reiknilíkan býður upp á.
- *Hafgola* — blási á strandstöðvum af hafi meðan stöðvar 20 km inn til landsins
  gera það ekki, þá er hafgola í gangi. Stuðullinn sameinar þá stefnubreytingu,
  styrk þrýstivindsins, sólskinið og hitamun lands og sjávar.
- *Breytingar* — þriggja klukkustunda leitni í þrýstingi, hita og vindi.

**Grunnur.** Reiknilíkan úr ECMWF-straumi Open-Meteo (ókeypis, enginn lykill).
Náist ekki í það er spáin byggð á mælingunum einum: þrýstivindurinn færður niður
að yfirborði, dægursveifla í hita þar sem sveifluvíddin kemur úr mælda
sólskininu, og skýjahula stýrð af þrýstibreytingunni. Síðan segir hvor leiðin
var farin.

**Leiðréttingar.** Í þremur skrefum:

1. Fyrstu klukkustundirnar eru blandaðar að því sem er verið að mæla núna, og
   vægi mælingarinnar fjarar út á um átta klukkustundum.
2. Hafgolan er lögð sem vigur ofan á stærra flæðið, svo andstæður þrýstivindur
   vinnur á móti henni en samstæður magnar hana. Síðdegishitinn er takmarkaður
   nálægt sjávarhitanum þegar vindinn leggur af hafi.
3. Appið dregur frá sína eigin fyrri skekkju, í sex klukkustunda þrepum eftir
   fyrirvara — um leið og að minnsta kosti tólf samanburðir liggja fyrir í hverju
   þrepi.

**Tímabil.** Sjö dagar, klukkustund fyrir klukkustund. Fyrsti sólarhringurinn er
þar sem staðbundnu leiðréttingarnar vinna sitt verk; eftir um sólarhring er
spáin í raun reiknilíkanið sjálft, og flipinn Næstu dagar segir frá því.

**Sannprófun.** Hver spá er geymd og síðar pöruð við næstu mælingu innan 25
mínútna. Meðalskekkja eftir fyrirvara birtist á flipanum Nákvæmni og fer inn í
skref 3, svo appið verður smám saman nákvæmara á þínum tiltekna stað.

## Kortið og sleðinn

Stöðvarnar eru dregnar upp á alvöru kort — Leaflet með ljósum grunnkortum frá
CARTO, hvort tveggja ókeypis og án lykils, með heimildum í horninu. Hver stöð ber
merki með hitanum sínum og vindör; farðu yfir hana með músinni (eða pikkaðu á
hana í síma) til að sjá allar mælingarnar, þar á meðal veghitann, sem er einmitt
skynjarinn sem sólskinsmatið byggir á. Náist ekki í kortaþjóninn teiknar síðan
einfalt yfirlit sjálf, svo hún virkar áfram án nets.

Þysjaðu með skrunhjólinu, með fingurgripi eða +/- hnöppunum; hnappurinn þar
fyrir neðan stillir kortið aftur að stöðvunum. Skrunhjólið þysjar kortið alltaf
þegar bendillinn er yfir því, svo skrunaðu framhjá kortinu til hliðar ef þú ert á
leiðinni niður síðuna.

Merki sem myndu skarast í þeirri þysjun sem er í gangi verða að punkti og stækka
aftur þegar þú þysjar inn, svo ekkert felur sig á bak við annað. Stöðvar sem eru
innan við 1,5 km hvor frá annarri deila einu merki með talningu á; spjaldið telur
þær upp hverja fyrir sig með hæð yfir sjó og fjarlægð sem greina þær að, og
útskýrir hvers vegna þær eru tvær — Vegagerðin rekur oft fleiri en einn mæli á
sama vegkafla, sitt hvorum megin vegar eða í ólíkri hæð, svo tölurnar mega vel
vera ólíkar.

Síðan opnast á þeirri stöð sem er næst þér, leyfir þú vafranum að segja til um
staðsetningu — annars stendur heimastaðurinn. Sé næsta stöð lengra en 120 km í
burtu er hún hunsuð.

Allar stöðvar Vegagerðarinnar eru á kortinu, ekki bara þær sem eru næst
heimastaðnum. Smelltu á eina — eða á hnappinn á spjaldinu hennar — og öll síðan
færist yfir á hana: fyrirsögnin, veðurspjaldið, klukkustundataflan, vikan,
Greining og miðgildisspjaldið fylgja með, og merkið fær ramma svo sjáist hvaða
stöð er valin. Smelltu á bæjarmerkið, eða á örina við fyrirsögnina, til að fara
til baka.

Stöð fær sömu meðferð og heimastaðurinn. Reiknilíkönin sjö eru sótt fyrir hnit
hennar í einni fyrirspurn þegar þú smellir — ekkert er sótt fyrir stöðvar sem þú
skoðar aldrei — miðgildið er reiknað úr þeim, og það er svo dregið að mælingum
stöðvarinnar sjálfrar með sama vægi og fjarar út á sama hátt og heima. Greining
er skrifuð upp úr hennar eigin mælingum: hitanum, vindinum, veghitanum sem gefur
sólskinið, hæðinni yfir sjó, ásamt þrýstisviðinu yfir landinu. Miðgildisspjaldið
efst í horninu sýnir hennar spár og hlekkurinn opnar samanburðinn fyrir hana.

Tvennt á þó eðli málsins samkvæmt aðeins við heimastaðinn: hafgolan, sem þarf
strandlengju og sjávarhita til að reiknast, og Nákvæmni, sem er samanburður á
spám Veðurvaktar og mælingum sem safnast hefur upp á heimastaðnum.

Yfir kortinu eru þrír hnappar: **Hiti**, **Vindur** og **Úrkoma**. Hver þeirra
kveikir sitt lag og heldur því; smellur aftur slekkur á því. **Vindur** kveikir
bæði litinn og hvítu agnirnar sem líða eftir vindinum — sami hluturinn, sama
lagið. Þau má hafa öll í einu — hitann skyggðan, regnið ofan á honum og
vindinn líðandi yfir hvort tveggja — og hver kvarði sem er í notkun birtist
undir kortinu. Séu tvö heilþekjandi lög valin þynnist það efra svo bæði sjáist.
Úrkoman er hvort eð er gagnsæ þar sem ekki rignir.

Kortið sjálft er í þremur lögum: teiknuð grunnmynd, hæðarskygging Esri ofan á
henni sem gefur landinu dýpt, og örnefnin efst — ofan við veðurlitina, svo þau
séu læsileg hvað sem er málað undir. Veðurlitirnir margfaldast inn í kortið í
stað þess að hylja það, þannig að strandlína, vegir og fjöllin sjást í gegn. Litirnir eru okkar eigin: hitinn liggur frá blágráum basalti gegnum sjávargrænt
og sand yfir í glóð, vindurinn frá ljósum sandi upp í djúpplómu, og úrkoman frá
myntugrænu niður í blekblátt. Sjálfur liturinn á kortinu er ekki fenginn að láni
úr reiknilíkani heldur brúaður úr stöðvanetinu sjálfu — hverjum punkti er gefið vægi eftir fjarlægð frá stöðvunum
á skjánum, og liturinn dofnar út þar sem engin stöð er innan seilingar, svo
kortið þykist aldrei vita hvað er að gerast langt úti á hafi. Litakvarðarnir eru
okkar eigin. Í kortalögunum sýnir hvert merki eina tölu, því liturinn ber
mynstrið; **Stöðvar** sýnir aftur hita og vind saman eins og áður.

Í vindlaginu líða hvítar agnir eftir vindinum. Vindvigrinum er brúað á net
yfir skjáinn, agnirnar reknar áfram eftir því og slóðin látin dofna hægt út.
Hreyfingin er ýkt — tíu metrar á sekúndu lesast sem um fjörutíu punktar á
sekúndu — því raunhraði á þessum skala væri varla sjáanlegur.

Hnappurinn efst í hægra horni kortsins stækkar það upp í allan gluggann; þar
fylgja bæði kortalögin og sleðinn með, svo hægt er að fletta gegnum vikuna í
fullri stærð. Esc eða sami hnappur minnkar það aftur. Hnappurinn þar undir
stillir kortið aftur að stöðvunum.

Úrkoman kemur alltaf úr reiknilíkaninu, líka á líðandi stundu: stöðvar
Vegagerðarinnar mæla ekki úrkomu.

Náist ekki í reiknilíkanið fyrir stöðvarnar — Open-Meteo takmarkar fjölda
fyrirspurna og margar byggingar í röð geta rekist á það — er kortið leitt af
mælingum stöðvanna sjálfra: munur hverrar stöðvar frá heimastaðnum núna er
færður áfram eftir spánni fyrir heimastaðinn. Það er hrátt þegar langt er liðið
á spána, en það er mælt, og textinn undir kortinu segir frá því. Appið bíður
síðan í tuttugu mínútur áður en það reynir aftur, í stað þess að ganga á
takmörkin í hverri keyrslu. Hiti og vindur eru mælingar á núllstundinni og
spá eftir það.

Undir kortinu liggur sleði yfir alla sjö dagana, með dagana nefnda fyrir ofan og
klukkustundirnar merktar fyrir neðan, eins og á vedur.is. Þegar hann er dreginn
færist veðurspjaldið, klukkustundataflan og allt kortið — hvert stöðvarmerki
skiptir úr mælingu sinni yfir í spá reiknilíkansins fyrir þá stund, teiknað með
brotinni línu svo þessu tvennu verði aldrei ruglað saman, og spjaldið fær
spárreit ofan við mælingarnar. Sú spá er sótt fyrir allar stöðvar í einu
(Open-Meteo tekur við mörgum hnitum í sömu fyrirspurn), á klukkustundar fresti
fyrsta sólarhringinn og á þriggja tíma fresti eftir það, og brúað þar á milli —
vindáttin gegnum vigurinn sinn, svo hún snúist styttri leiðina. Hún geymist í
þrjá tíma í stað þess að vera sótt í hverri tuttugu mínútna keyrslu, og ef hún
vantar sitja stöðvarnar einfaldlega áfram á mælingunum og textinn segir frá því.
**Núna** fer aftur á líðandi stund, smellur á dagsheiti stekkur þangað, smellur á
línu í töflunni velur þá klukkustund, og örvatakkarnir færa sig um eina
klukkustund í einu.

## Lagalegt

Þrjár síður fylgja: `skilmalar.html`, `personuvernd.html` og `heimildir.html`,
tengdar neðst á hverri síðu. **Áður en síðan fer í loftið undir eigin léni þarf
að fylla út `{NAFN}`, `{NETFANG}` og `{HEIMILISFANG}` í tveimur fyrstu
skjölunum** — lög nr. 30/2002 um rafræn viðskipti krefjast þess að hægt sé að sjá
hver stendur að síðunni og ná í viðkomandi.

Tvennt sem má ekki gleymast:

- **Ekkert í atvinnuskyni.** Frí notkun Open-Meteo er bundin við notkun sem er
  ekki í atvinnuskyni, og sama á við um ókeypis þjónustur Esri. Auglýsingar eða
  áskrift á síðunni myndu rjúfa hvort tveggja og kalla á keypt leyfi.
- **Spáin er ekki opinber.** Veðurstofa Íslands fer með útgáfu viðvarana að
  lögum. Síðan má hvorki líta út fyrir að vera opinber né gefa í skyn tengsl við
  Veðurstofuna; textinn á síðunni tekur það skýrt fram.

## Eigið lén

Sjálfgefna slóðin er `NOTANDANAFN.github.io/vedurvakt/`. Viljirðu eigið lén er
ódýrast — og fljótlegast — að nota undirlén af léni sem þú átt þegar, til dæmis
`vedur.mittlen.is`. Nýtt `.is`-lén fæst hjá ISNIC og kostar árgjald.

Segðu appinu frá léninu einu sinni:

```bash
python3 vedurvakt.py config --set domain=vedurvakt.is
```

Þá skrifar hver bygging `CNAME`-skrá með léninu, svo það haldist þótt Pages sé
endurstillt.

Svo tvennt í viðbót:

1. **Hjá lénaskránni** (ISNIC eða þar sem lénið er vistað):
   - *Undirlén* (`vedur.mittlen.is`): ein CNAME-færsla sem vísar á
     `NOTANDANAFN.github.io.` — punkturinn í endann skiptir máli.
   - *Rótarlén* (`mittlen.is`): fjórar A-færslur á `185.199.108.153`,
     `185.199.109.153`, `185.199.110.153` og `185.199.111.153`.
2. **Á GitHub:** Settings → Pages → *Custom domain* → sláðu lénið inn og vistaðu.
   Þegar hakið *Enforce HTTPS* verður valanlegt (getur tekið nokkrar mínútur upp
   í sólarhring meðan skírteinið er gefið út), kveiktu á því.

Staðsetningarþjónusta vafrans krefst HTTPS, svo appið opnast ekki á næstu stöð
fyrr en skírteinið er komið í gagnið.

## Forskoðun á hlekknum

Þegar hlekknum er deilt — í skilaboðum, á samfélagsmiðli, hvar sem er — birtist
kort með veðrinu eins og það stendur: staðurinn, hitinn, vindurinn og næstu sex
klukkustundir. Myndin (`og.png`) er teiknuð upp á nýtt í hverri keyrslu, svo
forskoðunin er aldrei eldri en tuttugu mínútna.

Til þess þarf appið að vita slóð síðunnar, því forskoðunarþjónar krefjast fullra
slóða:

```bash
python3 vedurvakt.py config --set site_url=https://vedurvakt.is
```

Sé `domain` þegar sett er slóðin leidd af því og ekkert frekar þarf.

Myndin er það eina í öllu verkefninu sem þarf pakka utan staðalsafnsins
(Pillow). Sé hann ekki uppsettur sleppir byggingin myndinni og heldur áfram;
GitHub Action setur hann upp sjálft.

Athugaðu að forskoðunin sýnir veðrið á heimastaðnum, ekki hjá þeim sem fær
hlekkinn. Forskoðunarþjónar keyra hvorki JavaScript né staðsetningu — þeir sækja
bara eina mynd — svo þetta er eins nálægt og hægt er að komast án bakenda.

## Að setja appið upp

Síðan er sett upp sem forrit beint úr vafranum — ekkert app store, engin
uppsetningarskrá.

- **iPhone og iPad:** opnaðu hlekkinn í Safari, ýttu á deilihnappinn og veldu
  *Bæta á heimaskjá*.
- **Android:** Chrome býður sjálfur upp á *Setja upp forrit*, annars er það í
  þrípunktavalmyndinni.
- **Mac og PC:** Chrome og Edge sýna uppsetningartákn hægra megin í
  slóðarreitnum; í Safari er það *Archive → Add to Dock*.

Eftir það opnast Veðurvakt í eigin glugga með sínu tákni og án slóðarreits.

Þjónusturáðurinn (`sw.js`) geymir síðuna og síðustu spá sem náðist í, svo hún
opnast líka án nets — þá stendur einfaldlega hversu gömul gögnin eru, eins og
alltaf. Hann sækir alltaf af netinu fyrst og notar geymsluna aðeins þegar netið
svarar ekki; það er örlítið hægara en tryggir að appið sitji aldrei fast á
gamalli útgáfu af sjálfu sér.

## Samanburður spáa

Spjaldið efst í hægra horninu sýnir miðgildi allra spáa sem appið nær í. Smelltu
á það til að opna samanburðarsíðuna (`samanburdur.html`) — fyrir heimastaðinn, eða
fyrir stöðina sem er valin, og þá er hún sótt beint í vafranum: miðgildið klukkustund
fyrir klukkustund með veðurtákni fyrir hverja, línurit af miðgildinu með bilinu
milli hæstu og lægstu spár á bak við, og fylki með öllum spágjöfum hlið við hlið
— þar sem skipta má milli hita, vinds, úrkomu og skýjahulu, með tákni miðgildisins
vinstra megin svo tölurnar hafi eitthvað til að hengja sig á.

Allir spágjafar eru ókeypis og krefjast ekki lykils:

| Spágjafi | Hvaðan hann kemur |
| --- | --- |
| Veðurstofan | Punktaspá af `xmlweather.vedur.is` fyrir næstu stöð sem birtir slíka, fundin sjálfkrafa gegnum `api.vedur.is/weather/stations` |
| Yr | Locationforecast 2.0 frá norsku veðurstofunni |
| ECMWF IFS | Evrópska reiknimiðstöðin, gegnum Open-Meteo |
| HARMONIE | KNMI, gegnum Open-Meteo |
| ICON | DWD, gegnum Open-Meteo |
| UKMO | Breska veðurstofan, gegnum Open-Meteo |
| AROME/ARPEGE | Météo-France, gegnum Open-Meteo |
| GFS | NOAA, gegnum Open-Meteo |
| GEM | Umhverfisstofnun Kanada, gegnum Open-Meteo |
| Veðurvakt | spá appsins sjálfs, leiðrétt með gögnum Vegagerðarinnar |

Reiknilíkönin sjö koma öll í einni fyrirspurn, svo allur samanburðurinn kostar
þrjár heimsóknir á netið. Hver spágjafi geymist í gagnagrunninum; náist ekki í
einhvern þeirra er síðasta gilda eintakið notað í allt að fjórar klukkustundir og
merkt sem eldri gögn, svo ein bilun tæmir aldrei töfluna.

Miðgildi vindáttar er reiknað úr þáttum vindvigursins en ekki úr hornunum
sjálfum, svo spár sitt hvorum megin við norður endi ekki að meðaltali í suðri.
Súlan við hverja vindtölu sýnir hversu vel spágjöfunum ber saman um áttina.

## Stillingar

```bash
python3 vedurvakt.py config --set lat=63.8583 lon=-21.3833 name=Þorlákshöfn
python3 vedurvakt.py config --set port=8787 radius_km=45
python3 vedurvakt.py config --set use_nwp_baseline=false   # mælingar eingöngu
```

`sea_bearing` (sjálfgefið 185) er sú átt sem opið haf liggur í. Hún ræður úr
hvaða átt hafgolan blæs — breyttu henni ef þú beinir appinu á stað þar sem
ströndin snýr öðruvísi. Stillingarnar eru í `~/.vedurvakt/config.json`; í GitHub
Actions er sjálfgefna uppsetningin notuð nema þú setjir þína eigin í geymsluna.

## Það sem appið getur ekki

Eftir um sólarhring er þetta ekki betra en reiknilíkanið sem það leiðréttir;
gildið liggur í næstu klukkustundum og staðbundnu leiðréttingunum. Það er hvorki
ratsjá, gervihnattamynd né úrkomumæling í spilinu, svo úrkoman kemur úr líkaninu
og ekkert sannreynir hana. Vegagerðin birtir gögnin sín óyfirfarin — einstakir
skynjarar bila — og þess vegna eru verstu leifarnar skornar burt þegar þrýstiplanið
er fellt.

Allt sem appið segir er á íslensku: síðan, flipinn Greining (skrifaður beint upp
úr greiningunni fremur en þýddur) og allur útprentur skipananna í skjánum, þar á
meðal loggur, spátaflan og `--help`. Aðeins athugasemdirnar í kóðanum eru á ensku.

Fyrir viðvaranir og opinberar spár er Veðurstofan rétti staðurinn.
