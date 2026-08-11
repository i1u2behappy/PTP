@echo off
cd /d "c:\Users\seyi_MOVE\Project\scrape"
(
  echo waiting for postgres container...
  set DBREADY=
  for /L %%i in (1,1,45) do (
    if not defined DBREADY (
      docker exec scrape-postgres pg_isready >nul 2>&1
      if not errorlevel 1 set DBREADY=1
      if not defined DBREADY ping -n 3 127.0.0.1 >nul
    )
  )
  echo postgres wait done, starting dev server
  call npm run dev:clean
) > .dev-server.log 2>&1
