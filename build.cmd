@echo off
rem Builds MiiXRay.exe with the C# compiler that ships with the .NET Framework 4.x (no SDK, no NuGet).
rem   build.cmd         builds bin\MiiXRay.exe
rem   build.cmd test    also builds and runs the tests
setlocal
cd /d "%~dp0"

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
    echo The .NET Framework 4.x C# compiler was not found under %WINDIR%\Microsoft.NET.
    echo Install the .NET Framework 4.8 or build MiiXRay.csproj with Visual Studio.
    exit /b 1
)

if not exist bin mkdir bin

set "OPTIONS=/nologo /langversion:5 /optimize+ /warn:4 /warnaserror+ /nowarn:1591 /reference:System.Security.dll /resource:src\Generate\RuntimeSource.txt,MiiXRay.RuntimeSource.txt"

"%CSC%" %OPTIONS% /target:exe /out:bin\MiiXRay.exe /recurse:src\*.cs
if errorlevel 1 exit /b 1
echo Built bin\MiiXRay.exe

if /i not "%~1"=="test" exit /b 0

"%CSC%" %OPTIONS% /target:exe /out:bin\MiiXRay.Tests.exe /main:MiiXRay.Tests.TestProgram /recurse:src\*.cs /recurse:tests\*.cs
if errorlevel 1 exit /b 1
bin\MiiXRay.Tests.exe
exit /b %errorlevel%
