import { useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import {
  H0_PUBLIC_COPY_PREFIX,
  createH0ProbeMaterial,
  evaluateH0Snapshot,
  hashH0PublicCopy,
  parseH0PublicCopy,
} from "./src/h0-lifecycle-probe";
import { persistConfirmedProvisioning, type PayerRecoveryStoragePort } from "./src/onchain-recovery-controller";
import { ONCHAIN_BRANCH_STORAGE, ONCHAIN_DEVICE_KEY_STORAGE, ONCHAIN_PROVISIONING_STORAGE } from "./src/payer-storage-keys";

type Scenario = "initial" | "valid" | "lost-secure-key" | "public-only" | "imported-public" | "reset";

interface ProbeView {
  readonly scenario: Scenario;
  readonly outcome: string;
  readonly error: string | null;
  readonly publicHash: string | null;
  readonly publicPresent: boolean;
  readonly secretPresent: boolean;
  readonly economicAuthorityAvailable: boolean;
}

const storagePort: PayerRecoveryStoragePort = {
  load: async () => ({
    provisioningJson: await AsyncStorage.getItem(ONCHAIN_PROVISIONING_STORAGE),
    branchStateJson: await AsyncStorage.getItem(ONCHAIN_BRANCH_STORAGE),
    deviceSecretHex: await SecureStore.getItemAsync(ONCHAIN_DEVICE_KEY_STORAGE),
  }),
  commit: async (snapshot) => {
    await AsyncStorage.setItem(ONCHAIN_BRANCH_STORAGE, snapshot.branchStateJson);
    await AsyncStorage.setItem(ONCHAIN_PROVISIONING_STORAGE, snapshot.provisioningJson);
    await SecureStore.setItemAsync(ONCHAIN_DEVICE_KEY_STORAGE, snapshot.deviceSecretHex, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  },
};

async function resetStorage(): Promise<void> {
  await AsyncStorage.multiRemove([ONCHAIN_PROVISIONING_STORAGE, ONCHAIN_BRANCH_STORAGE]);
  await SecureStore.deleteItemAsync(ONCHAIN_DEVICE_KEY_STORAGE);
}

async function inspect(scenario: Scenario): Promise<ProbeView> {
  const snapshot = await storagePort.load();
  const result = await evaluateH0Snapshot(snapshot);
  const publicPresent = snapshot.provisioningJson !== null && snapshot.branchStateJson !== null;
  const publicHash = publicPresent
    ? hashH0PublicCopy({ version: 1, provisioningJson: snapshot.provisioningJson as string, branchStateJson: snapshot.branchStateJson as string })
    : null;
  return {
    scenario,
    outcome: result.outcome,
    error: result.localValidationError,
    publicHash,
    publicPresent,
    secretPresent: snapshot.deviceSecretHex !== null,
    economicAuthorityAvailable: result.economicAuthorityAvailable,
  };
}

function Action({ label, onPress, secondary = false }: { readonly label: string; readonly onPress: () => void; readonly secondary?: boolean }) {
  return <TouchableOpacity onPress={onPress} style={[styles.action, secondary && styles.actionSecondary]}><Text style={[styles.actionText, secondary && styles.actionTextSecondary]}>{label}</Text></TouchableOpacity>;
}

function ImportScanner({ onImport, onCancel }: { readonly onImport: (value: string) => void; readonly onCancel: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  if (!permission) return <View style={styles.center}><Text>Preparando câmera…</Text></View>;
  if (!permission.granted) return <View style={styles.center}><Text style={styles.body}>A câmera copiará somente o estado público H0.</Text><Action label="PERMITIR CÂMERA" onPress={() => void requestPermission()} /><Action label="CANCELAR" secondary onPress={onCancel} /></View>;
  return <View style={styles.scanner}><CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }: BarcodeScanningResult) => onImport(data)} /><View style={styles.scanOverlay}><Text style={styles.scanTitle}>Escaneie a cópia pública do Device A</Text><Action label="CANCELAR" secondary onPress={onCancel} /></View></View>;
}

export default function H0LifecycleApp() {
  const material = useMemo(() => createH0ProbeMaterial(), []);
  const [view, setView] = useState<ProbeView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const importLocked = useRef(false);

  const run = (operation: () => Promise<ProbeView>) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    void operation().then(setView).catch((reason: unknown) => setFailure(reason instanceof Error ? reason.message : "falha H0 inesperada")).finally(() => setBusy(false));
  };

  useEffect(() => run(() => inspect("initial")), []);

  const seedValid = () => run(async () => {
    await resetStorage();
    await persistConfirmedProvisioning(storagePort, material.persisted);
    return inspect("valid");
  });
  const loseSecureKey = () => run(async () => {
    await SecureStore.deleteItemAsync(ONCHAIN_DEVICE_KEY_STORAGE);
    return inspect("lost-secure-key");
  });
  const restorePublicOnly = () => run(async () => {
    await resetStorage();
    await AsyncStorage.setItem(ONCHAIN_BRANCH_STORAGE, material.publicCopy.branchStateJson);
    await AsyncStorage.setItem(ONCHAIN_PROVISIONING_STORAGE, material.publicCopy.provisioningJson);
    return inspect("public-only");
  });
  const reset = () => run(async () => { await resetStorage(); return inspect("reset"); });
  const importPublic = (value: string) => {
    if (busy || importLocked.current) return;
    importLocked.current = true;
    setShowImport(false);
    run(async () => {
      try {
        const imported = parseH0PublicCopy(value);
        await resetStorage();
        await AsyncStorage.setItem(ONCHAIN_BRANCH_STORAGE, imported.branchStateJson);
        await AsyncStorage.setItem(ONCHAIN_PROVISIONING_STORAGE, imported.provisioningJson);
        return inspect("imported-public");
      } finally {
        importLocked.current = false;
      }
    });
  };

  if (showImport) return <SafeAreaView style={styles.safe}><StatusBar style="light" /><ImportScanner onImport={importPublic} onCancel={() => setShowImport(false)} /></SafeAreaView>;

  const authority = view?.economicAuthorityAvailable ?? false;
  return <SafeAreaView style={styles.safe}><StatusBar style="dark" /><ScrollView contentContainerStyle={styles.container}>
    <Text style={styles.eyebrow}>OGP · INSTRUMENTAÇÃO H0</Text>
    <Text style={styles.title}>Prova de isolamento local</Text>
    <View style={[styles.result, authority ? styles.authorityOn : styles.authorityOff]}>
      <Text style={styles.resultLabel}>Autoridade econômica offline</Text>
      <Text style={styles.resultValue}>{authority ? "ATIVA — PROBE H0" : "ZERO — FAIL-CLOSED"}</Text>
      <Text style={styles.resultDetail}>Resultado: {view?.outcome ?? "carregando"}</Text>
      <Text style={styles.resultDetail}>Estado público: {view?.publicPresent ? "presente" : "ausente"}</Text>
      <Text style={styles.resultDetail}>Chave protegida: {view?.secretPresent ? "presente" : "ausente"}</Text>
    </View>
    {view?.publicHash && <View style={styles.hashCard}><Text style={styles.hashLabel}>SHA-256 da cópia pública</Text><Text selectable style={styles.hash}>{view.publicHash}</Text></View>}
    {(failure ?? view?.error) && <View style={styles.error}><Text style={styles.errorText}>{failure ?? view?.error}</Text></View>}
    <Text style={styles.note}>Package isolado: protocol.ogp.payer.h0. Este aplicativo não é o payer de produção e não acessa RPC.</Text>
    <Action label="1 · SEMEAR SESSÃO VÁLIDA" onPress={seedValid} />
    <Action label="2 · APAGAR SÓ A CHAVE PROTEGIDA" onPress={loseSecureKey} />
    <Action label="3 · RESTAURAR SOMENTE ESTADO PÚBLICO" onPress={restorePublicOnly} />
    <Action label="MOSTRAR QR DA CÓPIA PÚBLICA" onPress={() => setShowExport((current) => !current)} secondary />
    {showExport && <View style={styles.qrCard}><QRCode value={`${H0_PUBLIC_COPY_PREFIX}${material.publicCopyJson}`} size={270} ecl="L" quietZone={10} /><Text style={styles.qrText}>Hash {material.publicCopyHash.slice(0, 16)}…</Text></View>}
    <Action label="IMPORTAR CÓPIA PÚBLICA DE OUTRO APARELHO" onPress={() => setShowImport(true)} secondary />
    <Action label="RESETAR PROBE H0" onPress={reset} secondary />
    {busy && <Text style={styles.busy}>Executando operação durável…</Text>}
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f4f1e8" },
  container: { padding: 24, gap: 14 },
  center: { flex: 1, padding: 24, justifyContent: "center", gap: 16 },
  eyebrow: { color: "#177467", fontWeight: "800", letterSpacing: 2 },
  title: { color: "#102a25", fontSize: 34, lineHeight: 40, fontWeight: "800" },
  body: { color: "#40534f", fontSize: 17, lineHeight: 24 },
  result: { borderRadius: 24, padding: 20, gap: 8 },
  authorityOn: { backgroundColor: "#fff0c2", borderWidth: 2, borderColor: "#d99b00" },
  authorityOff: { backgroundColor: "#dff3ed", borderWidth: 2, borderColor: "#177467" },
  resultLabel: { color: "#40534f", fontSize: 15 },
  resultValue: { color: "#102a25", fontSize: 23, fontWeight: "900" },
  resultDetail: { color: "#29433d", fontSize: 15 },
  hashCard: { backgroundColor: "white", borderRadius: 18, padding: 16, gap: 8 },
  hashLabel: { color: "#566a65", fontWeight: "700" },
  hash: { color: "#102a25", fontFamily: "monospace", fontSize: 12 },
  error: { backgroundColor: "#ffe3dd", borderRadius: 16, padding: 14 },
  errorText: { color: "#8b2f20", fontWeight: "700" },
  note: { color: "#5f706b", fontSize: 14, lineHeight: 20 },
  action: { minHeight: 58, borderRadius: 16, padding: 14, backgroundColor: "#177467", alignItems: "center", justifyContent: "center" },
  actionSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#70817c" },
  actionText: { color: "white", fontWeight: "800", textAlign: "center" },
  actionTextSecondary: { color: "#29433d" },
  qrCard: { backgroundColor: "white", borderRadius: 20, padding: 16, alignItems: "center", gap: 8 },
  qrText: { color: "#40534f", fontFamily: "monospace" },
  busy: { color: "#177467", textAlign: "center", fontWeight: "700" },
  scanner: { flex: 1 },
  scanOverlay: { position: "absolute", left: 20, right: 20, bottom: 40, gap: 12 },
  scanTitle: { color: "white", backgroundColor: "rgba(16,42,37,0.85)", borderRadius: 16, padding: 16, textAlign: "center", fontWeight: "800", fontSize: 18 },
});
