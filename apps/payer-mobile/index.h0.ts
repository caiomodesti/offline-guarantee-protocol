import "./polyfill";
import { registerRootComponent } from "expo";
import React from "react";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";
import H0LifecycleApp from "./App.h0";

interface BoundaryState { readonly message: string | null }
interface BoundaryProps { readonly children?: React.ReactNode }

class H0ErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { message: null };
  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { message: error instanceof Error ? error.message : "Falha inesperada na instrumentação H0" };
  }
  render() {
    if (this.state.message !== null) return React.createElement(SafeAreaView, { style: styles.safe }, React.createElement(View, { style: styles.center }, React.createElement(Text, { style: styles.title }, "Falha na instrumentação H0"), React.createElement(Text, { style: styles.body }, this.state.message)));
    return this.props.children;
  }
}

registerRootComponent(() => React.createElement(H0ErrorBoundary, null, React.createElement(H0LifecycleApp)));

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f4f1e8" },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center", gap: 16 },
  title: { color: "#102a25", fontSize: 28, fontWeight: "800", textAlign: "center" },
  body: { color: "#40534f", fontSize: 15, lineHeight: 22, textAlign: "center" },
});
