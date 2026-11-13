@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0" || goto :error

echo =========================================
echo    Mise a jour automatique sur GitHub
 echo =========================================
echo.

where git >nul 2>&1 || (
    echo ERREUR : Git n'est pas installe ou introuvable.
    goto :error
)

if not exist ".git" (
    echo ERREUR : Aucun depot Git dans ce dossier.
    echo Place ce fichier a la racine d'un projet deja configure.
    goto :error
)

git rev-parse --is-inside-work-tree >nul 2>&1 || (
    echo ERREUR : Le depot Git est invalide.
    goto :error
)

git remote get-url origin >nul 2>&1 || (
    echo ERREUR : Aucun remote GitHub "origin" configure.
    goto :error
)

echo [1/3] Preparation de tous les changements...
git add -A || goto :error

git diff --cached --quiet
if errorlevel 2 goto :error
if errorlevel 1 (
    echo [2/3] Creation du commit...
    git commit -m "Mise a jour automatique" || goto :error
) else (
    echo [2/3] Aucun nouveau changement a enregistrer.
)

echo [3/3] Envoi sur GitHub...
git rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" >nul 2>&1
if errorlevel 1 (
    git push -u origin HEAD || goto :error
) else (
    git push || goto :error
)

echo.
echo SUCCES : GitHub est a jour.
timeout /t 3 /nobreak >nul
exit /b 0

:error
echo.
echo ECHEC : La mise a jour n'a pas ete terminee.
echo Regarde le message ci-dessus pour identifier le probleme.
pause
exit /b 1
