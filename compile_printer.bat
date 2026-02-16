@echo off
set CSC_PATH=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe

if not exist "%CSC_PATH%" (
    echo CSC not found at default location. Trying v3.5...
    set CSC_PATH=%SystemRoot%\Microsoft.NET\Framework64\v3.5\csc.exe
)

if not exist "%CSC_PATH%" (
    echo Error: C# Compiler (csc.exe) not found. cannot compile RawPrint.
    exit /b 1
)

"%CSC_PATH%" /target:exe /out:resources\printer\RawPrint.exe resources\printer\RawPrint.cs

if %errorlevel% neq 0 (
    echo Compilation failed!
    exit /b %errorlevel%
)

echo Compilation successful: resources\printer\RawPrint.exe
