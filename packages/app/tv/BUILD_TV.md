# Rajada nas TVs — empacotamento

O Rajada é uma web app. Cada TV roda o **mesmo `dist/`** (buildado com `base:'./'`),
só muda o "embrulho". O `tv/stage.mjs` monta a pasta de cada plataforma em
`tv/build/<plataforma>/` (index.html + assets + manifesto + ícones). Daí a CLI do
fabricante gera o pacote instalável.

| TV | Pacote | Precisa | Status |
|----|--------|---------|--------|
| Android TV / Google TV / Fire TV | **APK** (o mesmo do celular) | adb | ✅ já funciona |
| Samsung (Tizen) | **.wgt** | Tizen Studio/CLI + certificado Samsung | empacotador pronto |
| LG (webOS) | **.ipk** | webOS CLI + TV em modo dev | empacotador pronto |

> Os ícones em `tv/tizen/` e `tv/webos/` são **placeholders** (R vermelho). Troque
> pelos definitivos quando tivermos o branding.

---

## Android TV / Google TV / Fire TV — sem novo empacotamento
Use o APK que já geramos:
```powershell
C:\Users\caduv\asdk\platform-tools\adb.exe connect <ip-da-tv>:5555
C:\Users\caduv\asdk\platform-tools\adb.exe install -r "android\app\build\outputs\apk\debug\app-debug.apk"
```
Na TV: ative Opções de desenvolvedor + Depuração. O app aparece na home (leanback) e
navega por controle (D-pad).

---

## Samsung (Tizen) → `.wgt`
**1. Instalar uma vez:** [Tizen Studio](https://developer.tizen.org/development/tizen-studio/download)
(com o "TV Extension"). Garanta que `tizen` (em `Tizen/tools/ide/bin`) está no PATH.

**2. Certificado (obrigatório):** no Tizen Studio → *Certificate Manager* → crie um
perfil **Samsung** (exige login na conta Samsung e o **DUID** da TV em modo dev).
Anote o nome do perfil — o script usa `-s rajada`, então nomeie o perfil **`rajada`**
(ou edite o script `pack:tizen` no package.json).

**3. TV em modo dev:** app *Apps* → digite `12345` → ative **Developer mode** e informe
o **IP do seu PC**. Reinicie a TV.

**4. Empacotar + instalar:**
```powershell
pnpm.cmd --filter @nexotv/app pack:tizen
# gera tv/build/tizen/.buildResult/Rajada.wgt
sdb connect <ip-da-tv>            # sdb vem no Tizen Studio
tizen install -n Rajada.wgt -- tv/build/tizen/.buildResult -t <serial-da-tv>
```
(ou instale pelo *Device Manager* do Tizen Studio).

---

## LG (webOS) → `.ipk`
**1. Instalar uma vez:** webOS CLI →
```powershell
npm install -g @webosose/ares-cli
```
(`ares-package`, `ares-install`, `ares-setup-device` ficam no PATH).

**2. TV em modo dev:** instale o app **Developer Mode** na LG Content Store, ligue o
modo dev (precisa de uma conta LG Developer gratuita) e anote IP + a senha/passphrase.

**3. Registrar a TV no PC:**
```powershell
ares-setup-device            # adiciona a TV (IP + key)
ares-novacom --device <nome> --getkey
```

**4. Empacotar + instalar:**
```powershell
pnpm.cmd --filter @nexotv/app pack:webos
# gera tv/build/com.rajada.app_0.1.0_all.ipk
ares-install --device <nome> tv/build/com.rajada.app_0.1.0_all.ipk
ares-launch --device <nome> com.rajada.app
```

---

## O vídeo (HTTP) nas TVs
O provedor é HTTP. Os manifestos já liberam acesso amplo:
- **Tizen:** `<access origin="*"/>` + `allow-navigation` + privilégio `internet`.
- **webOS:** web app local consegue carregar HTTP; a maioria das LG não bloqueia.

Mesmo assim, **cada TV tem manhas de codec/HLS** — só o aparelho real confirma se o
stream toca. Se travar numa TV específica, capture o log (`sdb dlog` no Tizen,
`ares-inspect` no webOS) que ajustamos o player.
