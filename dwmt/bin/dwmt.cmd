@echo off
rem dwmt z cmd.exe i PowerShell (katalog bin w PATH): dwmt heavy -- <komenda>, dwmt queue. Komenda biegnie w cmd.exe.
node "%~dp0..\scripts\dwmt.mjs" %*
