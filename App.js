import React from "react";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";

/**
 * KART FØRST
 *
 * Dette er kun en minimal native kart-test.
 * Ingen GPS-logikk, ingen radius, ingen rebusflyt.
 * Når dette virker i iPhone dev build, bygger vi videre ett steg om gangen.
 *
 * Dummy-koordinater. Ikke legg inn private hjemmepunkter i repo.
 */
const TEST_POSTS = [
  {
    id: "post-1",
    title: "Post 1",
    latitude: 59.91095,
    longitude: 10.7532,
  },
  {
    id: "post-2",
    title: "Post 2",
    latitude: 59.91125,
    longitude: 10.75385,
  },
  {
    id: "post-3",
    title: "Post 3",
    latitude: 59.91095,
    longitude: 10.7545,
  },
  {
    id: "post-4",
    title: "Post 4",
    latitude: 59.91065,
    longitude: 10.75385,
  },
];

function makeInitialRegion() {
  const latitudes = TEST_POSTS.map((post) => post.latitude);
  const longitudes = TEST_POSTS.map((post) => post.longitude);

  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);

  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * 3, 0.004),
    longitudeDelta: Math.max((maxLon - minLon) * 3, 0.004),
  };
}

export default function App() {
  const routeLine = TEST_POSTS.map((post) => ({
    latitude: post.latitude,
    longitude: post.longitude,
  }));

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.kicker}>Kart-test</Text>
        <Text style={styles.title}>Manuell Rebus-rute</Text>
        <Text style={styles.bodyText}>
          Første steg: få native kart til å vises i dev builden.
        </Text>
      </View>

      <MapView style={styles.map} initialRegion={makeInitialRegion()}>
        <Polyline coordinates={routeLine} strokeWidth={4} strokeColor="#2563eb" />

        {TEST_POSTS.map((post, index) => (
          <Marker
            key={post.id}
            coordinate={{ latitude: post.latitude, longitude: post.longitude }}
            title={`${index + 1}. ${post.title}`}
            description={`${post.latitude.toFixed(5)}, ${post.longitude.toFixed(5)}`}
          />
        ))}
      </MapView>

      <View style={styles.footer}>
        <Text style={styles.footerTitle}>Forventet resultat</Text>
        <Text style={styles.bodyText}>Kart + 4 markører + blå linje mellom postene.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#101114",
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
  },
  kicker: {
    color: "#9ca3af",
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  title: {
    color: "#ffffff",
    fontSize: 30,
    fontWeight: "800",
    marginTop: 6,
  },
  bodyText: {
    color: "#d1d5db",
    fontSize: 15,
    lineHeight: 21,
    marginTop: 8,
  },
  map: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: "#2d3340",
    backgroundColor: "#1c1f26",
  },
  footerTitle: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
  },
});
