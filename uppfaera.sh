#!/bin/bash
# Veðurvakt — sendir breytingar á GitHub og gengur frá birtingunni.
#
#   ./uppfaera.sh                 sendir breytingar með sjálfgefnum texta
#   ./uppfaera.sh "nýtt kort"     sendir breytingar með þínum texta
#   ./uppfaera.sh --yfirskrifa    lætur þessa möppu gilda og yfirskrifar GitHub
#
# Í fyrsta skipti stofnar skriftan geymsluna, kveikir á GitHub Pages og ræsir
# fyrstu keyrsluna. Eftir það er þetta einfaldlega: sendu það sem breyttist.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

# --yfirskrifa: þessi mappa er réttari en það sem er á GitHub.
yfirskrifa=0
if [ "${1:-}" = "--yfirskrifa" ]; then
  yfirskrifa=1
  shift
fi

hnappur() { printf '\n\033[1m%s\033[0m\n' "$1"; }
villa()   { printf '\033[31m%s\033[0m\n' "$1" >&2; }

# --- er gh til staðar? ------------------------------------------------------
if ! command -v gh >/dev/null 2>&1; then
  villa "GitHub-skipanalínuna (gh) vantar."
  echo "Settu hana inn með:  brew install gh"
  echo "Ef Homebrew er ekki til staðar: https://cli.github.com"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  hnappur "Skrái þig inn á GitHub"
  gh auth login || { villa "Innskráning tókst ekki."; exit 1; }
fi

# --- geymslan ---------------------------------------------------------------
if [ ! -d .git ]; then
  hnappur "Stofna git-geymslu"
  git init -b main >/dev/null || exit 1
fi

# Git neitar að skrá breytingar án nafns og netfangs. Á nýrri vél er hvorugt
# til, svo við sækjum hvort tveggja í GitHub-aðganginn sem er þegar innskráður.
if [ -z "$(git config user.email)" ]; then
  notandi=$(gh api user -q .login 2>/dev/null)
  audkenni=$(gh api user -q .id 2>/dev/null)
  if [ -n "$notandi" ] && [ -n "$audkenni" ]; then
    git config user.name "$notandi"
    git config user.email "$audkenni+$notandi@users.noreply.github.com"
    echo "Skráði þig sem $notandi í þessari geymslu."
  else
    villa "Git veit ekki hver þú ert."
    echo 'Keyrðu:  git config --global user.name "Nafnið þitt"'
    echo '         git config --global user.email "netfangid@þitt.is"'
    exit 1
  fi
fi

# Greinin heitir main nema hún heiti annað nú þegar.
grein=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo main)

if ! git diff --quiet || ! git diff --cached --quiet || \
   [ -n "$(git ls-files --others --exclude-standard)" ]; then
  texti=${1:-"uppfærsla $(date '+%d.%m.%Y %H:%M')"}
  git add -A
  git commit -m "$texti" >/dev/null || exit 1
  echo "Skráði breytingar: $texti"
  breyting=1
else
  echo "Engar breytingar síðan síðast."
  breyting=0
fi

# --- fjartengingin ----------------------------------------------------------
if ! git remote get-url origin >/dev/null 2>&1; then
  nafn=$(basename "$PWD")
  # Sé geymslan þegar til á GitHub tengjumst við henni í stað þess að stofna
  # nýja — það gerist í hvert sinn sem skrárnar eru teknar upp í nýrri möppu.
  fyrir=$(gh repo view "$nafn" --json url -q .url 2>/dev/null)
  if [ -n "$fyrir" ]; then
    hnappur "Tengist geymslunni sem er þegar til"
    git remote add origin "$fyrir.git"
    echo "$fyrir"
    git fetch origin >/dev/null 2>&1
    git push --force-with-lease -u origin "$grein" || {
      villa "Push tókst ekki."; exit 1; }
    echo "Sendi þessa möppu á GitHub."
  else
    hnappur "Stofna geymsluna $nafn á GitHub"
    gh repo create "$nafn" --public --source=. --push || {
      villa "Náði ekki að stofna geymsluna."
      echo "Prófaðu:  git remote add origin https://github.com/NOTANDI/$nafn.git"
      exit 1
    }
  fi
else
  hnappur "Sendi á GitHub"
  if [ "$yfirskrifa" -eq 1 ]; then
    # Sækjum fyrst svo --force-with-lease viti hvað er á GitHub og stöðvi
    # okkur ef eitthvað hefur breyst þar á meðan.
    git fetch origin >/dev/null 2>&1
    git push --force-with-lease -u origin "$grein" || {
      villa "Push tókst ekki þrátt fyrir --yfirskrifa."; exit 1; }
    echo "Yfirskrifaði það sem var á GitHub."
  elif ! git push -u origin "$grein"; then
    villa "Push tókst ekki."
    echo
    echo "Á GitHub er efni sem er ekki til í þessari möppu. Það gerist"
    echo "til dæmis þegar sömu skrár eru teknar upp á nýtt í nýja möppu."
    echo
    echo "Ef þessi mappa er sú rétta, keyrðu:"
    echo "    ./uppfaera.sh --yfirskrifa"
    echo
    echo "Ef þú vilt frekar halda því sem er á GitHub:"
    echo "    git pull --rebase origin $grein"
    exit 1
  fi
fi

slod=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
[ -z "$slod" ] && { villa "Fann ekki geymsluna á GitHub."; exit 1; }
eigandi=${slod%%/*}
nafn=${slod##*/}

# --- GitHub Pages -----------------------------------------------------------
# build_type=workflow þýðir að síðan er birt af Action-inu okkar.
if gh api "repos/$slod/pages" >/dev/null 2>&1; then
  gh api -X PUT "repos/$slod/pages" -f build_type=workflow >/dev/null 2>&1
else
  hnappur "Kveiki á GitHub Pages"
  if gh api -X POST "repos/$slod/pages" -f build_type=workflow \
       >/dev/null 2>&1; then
    echo "Pages er komið í gang."
  else
    villa "Náði ekki að kveikja á Pages sjálfkrafa."
    echo "Gerðu það í eitt skipti hér:"
    echo "  https://github.com/$slod/settings/pages"
    echo "  Source → GitHub Actions"
  fi
fi

# --- keyrslan ---------------------------------------------------------------
# Push ræsir Action-ið sjálfkrafa; annars ýtum við sjálf á það.
if [ "$breyting" -eq 0 ]; then
  hnappur "Ræsi uppfærslu"
  gh workflow run update.yml >/dev/null 2>&1 && echo "Keyrsla ræst." \
    || echo "Náði ekki að ræsa keyrsluna; hún fer af stað á næsta hring."
fi

hnappur "Tilbúið"
echo "Síðan:    https://$eigandi.github.io/$nafn/"
echo "Keyrslur: https://github.com/$slod/actions"
echo
echo "Fyrsta birtingin tekur um tvær mínútur. Eftir það uppfærist síðan"
echo "sjálfkrafa á tuttugu mínútna fresti."
