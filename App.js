import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from "react-native";
import * as Location from "expo-location";

const RADIUS_M = 500;
const FOUND_M = 25;

const KARTVERKET_URL = "https://ws.geonorge.no/stedsnavn/v1/punkt";
const RA_LAYERS = [
  "https://kart.ra.no/arcgis/rest/services/Distribusjon/Kulturminner/MapServer/0/query",
  "https://kart.ra.no/arcgis/rest/services/Distribusjon/Kulturminner/MapServer/1/query"
];

const rad = (v) => (v * Math.PI) / 180;
const deg = (v) => (v * 180) / Math.PI;

function distanceM(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(aLat, aLon, bLat, bLon) {
  const dLon = rad(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(rad(bLat));
  const x =
    Math.cos(rad(aLat)) * Math.sin(rad(bLat)) -
    Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(dLon);
  return ((deg(Math.atan2(y, x)) + 360) % 360);
}

function directionText(value) {
  return ["Nord", "Nordøst", "Øst", "Sørøst", "Sør", "Sørvest", "Vest", "Nordvest"][
    Math.round(value / 45) % 8
  ];
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstValue(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return null;
}

async function readJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 80)}`);
  return JSON.parse(text);
}

function queryString(params) {
  return params
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

function kartverketPoint(item) {
  const point = item?.representasjonspunkt || item?.geometry || item?.punkt;
  if (!point) return null;

  const latitude =
    toNumber(point.nord) ?? toNumber(point.latitude) ?? toNumber(point.lat) ?? toNumber(point.y);
  const longitude =
    toNumber(point.aust) ??
    toNumber(point["øst"]) ??
    toNumber(point.longitude) ??
    toNumber(point.lon) ??
    toNumber(point.lng) ??
    toNumber(point.x);

  return latitude !== null && longitude !== null ? { latitude, longitude } : null;
}

function kartverketName(item, index) {
  if (typeof item?.skrivemåte === "string") return item.skrivemåte;
  if (typeof item?.skrivemate === "string") return item.skrivemate;
  if (typeof item?.navn === "string") return item.navn;

  const names = item?.stedsnavn || item?.navn;
  if (Array.isArray(names)) {
    const match = names.find((value) => value?.skrivemåte || value?.skrivemate || value?.navn);
    return match?.skrivemåte || match?.skrivemate || match?.navn || `Stedsnavn ${index + 1}`;
  }

  return `Stedsnavn ${index + 1}`;
}

async function fetchKartverket(lat, lon) {
  const url =
    `${KARTVERKET_URL}?` +
    queryString([
      ["nord", lat],
      ["aust", lon],
      ["radius", RADIUS_M],
      ["koordsys", 4258],
      ["utkoordsys", 4258],
      ["treffPerSide", 20],
      ["side", 1]
    ]);

  const data = await readJson(url);
  const items = Array.isArray(data?.navn)
    ? data.navn
    : Array.isArray(data?.stedsnavn)
      ? data.stedsnavn
      : [];

  return items
    .map((raw, index) => {
      const item = raw?.properties || raw;
      const point = kartverketPoint(item);
      if (!point) return null;

      return {
        source: "Kartverket",
        name: kartverketName(item, index),
        latitude: point.latitude,
        longitude: point.longitude
      };
    })
    .filter(Boolean);
}

function raName(attributes, index) {
  return (
    firstValue(attributes, [
      "navn",
      "NAVN",
      "lokalitetsnavn",
      "LOKALITETSNAVN",
      "enkeltminneart",
      "ENKELTMINNEART",
      "kulturminneart",
      "KULTURMINNEART",
      "objektnavn",
      "OBJEKTNAVN"
    ]) ||
    firstValue(attributes, ["kategori", "KATEGORI", "art", "ART", "minnetype", "MINNETYPE"]) ||
    `Kulturminne ${index + 1}`
  );
}

async function fetchRiksantikvaren(lat, lon) {
  const posts = [];

  for (const layer of RA_LAYERS) {
    try {
      const url =
        `${layer}?` +
        queryString([
          ["f", "json"],
          ["where", "OBJECTID IS NOT NULL"],
          ["outFields", "*"],
          ["returnGeometry", "true"],
          ["geometry", `${lon},${lat}`],
          ["geometryType", "esriGeometryPoint"],
          ["inSR", 4326],
          ["outSR", 4326],
          ["spatialRel", "esriSpatialRelIntersects"],
          ["distance", RADIUS_M],
          ["units", "esriSRUnit_Meter"]
        ]);

      const data = await readJson(url);
      const features = Array.isArray(data?.features) ? data.features : [];

      features.forEach((feature, index) => {
        const geometry = feature?.geometry;
        const latitude = toNumber(geometry?.y);
        const longitude = toNumber(geometry?.x);

        if (latitude === null || longitude === null) return;

        posts.push({
          source: "Riksantikvaren",
          name: raName(feature.attributes || {}, index),
          latitude,
          longitude
        });
      });
    } catch (error) {
      console.log("Riksantikvaren-lag feilet:", layer, error?.message || error);
    }
  }

  return posts;
}

function selectRoute(userLat, userLon, rawPosts) {
  const seen = new Set();

  return rawPosts
    .map((post) => ({
      ...post,
      distanceFromStart: distanceM(userLat, userLon, post.latitude, post.longitude)
    }))
    .filter((post) => post.distanceFromStart >= 8 && post.distanceFromStart <= RADIUS_M)
    .filter((post) => {
      const key = `${post.source}:${post.name.toLowerCase()}:${post.latitude.toFixed(4)}:${post.longitude.toFixed(4)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.distanceFromStart - b.distanceFromStart)
    .slice(0, 2)
    .map((post, index) => ({
      ...post,
      id: `${post.source}-${index + 1}`,
      number: index + 1,
      found: false
    }));
}

async function hasGpsPermission() {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status === "granted") return true;
  Alert.alert("GPS kreves", "Rebus-testen må ha GPS-tilgang.");
  return false;
}

export default function App() {
  const [screen, setScreen] = useState("MENU");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("Klar.");
  const [apiStatus, setApiStatus] = useState("");
  const [location, setLocation] = useState(null);
  const [posts, setPosts] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (screen !== "REBUS") return undefined;

    let sub;
    let mounted = true;

    async function startWatch() {
      if (!(await hasGpsPermission())) return;

      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 1 },
        (nextLocation) => {
          if (mounted) setLocation(nextLocation);
        }
      );
    }

    startWatch();

    return () => {
      mounted = false;
      if (sub) sub.remove();
    };
  }, [screen]);

  const activePost = posts[activeIndex] || null;

  const activeDistance = useMemo(() => {
    if (!location || !activePost) return null;
    return distanceM(
      location.coords.latitude,
      location.coords.longitude,
      activePost.latitude,
      activePost.longitude
    );
  }, [location, activePost]);

  const activeBearing = useMemo(() => {
    if (!location || !activePost) return null;
    return bearing(
      location.coords.latitude,
      location.coords.longitude,
      activePost.latitude,
      activePost.longitude
    );
  }, [location, activePost]);

  async function startRebus() {
    setLoading(true);
    setStatus("Starter ekte API-test...");
    setApiStatus("Henter GPS...");
    setPosts([]);
    setActiveIndex(0);

    try {
      if (!(await hasGpsPermission())) return;

      const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setLocation(current);

      const lat = current.coords.latitude;
      const lon = current.coords.longitude;

      setApiStatus("Henter Kartverket og Riksantikvaren...");

      const [kvResult, raResult] = await Promise.allSettled([
        fetchKartverket(lat, lon),
        fetchRiksantikvaren(lat, lon)
      ]);

      const kv = kvResult.status === "fulfilled" ? kvResult.value : [];
      const ra = raResult.status === "fulfilled" ? raResult.value : [];
      const route = selectRoute(lat, lon, [...kv, ...ra]);

      setScreen("REBUS");
      setApiStatus(`Kartverket: ${kv.length} treff. Riksantikvaren: ${ra.length} treff.`);

      if (route.length < 2) {
        setStatus(`Fant bare ${route.length} gyldige post(er) innen ${RADIUS_M} meter. Flytt deg og prøv igjen.`);
        return;
      }

      setPosts(route);
      setStatus(`Sløyfe klar. Gå til post 1: ${route[0].name}`);
    } catch (error) {
      console.log("Rebus feilet:", error);
      Alert.alert("Rebus feilet", "Sjekk GPS og nettverk.");
      setStatus("Klarte ikke starte ekte API-test.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (screen !== "REBUS" || !location || !activePost || activePost.found) return;

    const d = distanceM(
      location.coords.latitude,
      location.coords.longitude,
      activePost.latitude,
      activePost.longitude
    );

    if (d <= FOUND_M) {
      const updated = posts.map((post, index) =>
        index === activeIndex ? { ...post, found: true } : post
      );
      setPosts(updated);

      const nextIndex = updated.findIndex((post) => !post.found);

      if (nextIndex === -1) {
        setStatus("Post funnet. Alle postene er funnet.");
      } else {
        setActiveIndex(nextIndex);
        setStatus(`Post ${activePost.number} funnet. Gå til post ${updated[nextIndex].number}: ${updated[nextIndex].name}`);
      }

      return;
    }

    const b = bearing(
      location.coords.latitude,
      location.coords.longitude,
      activePost.latitude,
      activePost.longitude
    );

    setStatus(`Gå mot ${directionText(b)}. Avstand: ${Math.round(d)} meter.`);
  }, [location, screen, activeIndex, activePost, posts]);

  function reset() {
    setScreen("MENU");
    setStatus("Klar.");
    setApiStatus("");
    setPosts([]);
    setActiveIndex(0);
  }

  if (screen === "MENU") {
    return (
      <View style={styles.menu}>
        <Text style={styles.menuTitle}>GPS Rebus Test</Text>
        <Text style={styles.menuText}>
          Henter to ekte poster innen 500 meter fra Kartverket og Riksantikvaren.
        </Text>

        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator size="large" color="#FFFFFF" />
            <Text style={styles.loadingText}>{apiStatus}</Text>
          </View>
        ) : (
          <TouchableOpacity style={styles.primaryButton} onPress={startRebus}>
            <Text style={styles.primaryButtonTitle}>START REBUS API-TEST</Text>
            <Text style={styles.primaryButtonText}>GPS • Kartverket • Riksantikvaren</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  const foundCount = posts.filter((post) => post.found).length;

  return (
    <ScrollView contentContainerStyle={styles.game}>
      <Text style={styles.title}>Rebus API-test</Text>

      <View style={styles.card}>
        <Text style={styles.status}>{status}</Text>
        <Text style={styles.meta}>{apiStatus}</Text>
        <Text style={styles.meta}>Poster funnet: {foundCount} / {posts.length}</Text>

        {activePost && !activePost.found ? (
          <View style={styles.postCard}>
            <Text style={styles.source}>{activePost.source}</Text>
            <Text style={styles.postName}>{activePost.name}</Text>
            <Text style={styles.postMeta}>
              Avstand: {activeDistance === null ? "venter på GPS" : `${Math.round(activeDistance)} m`}
            </Text>
            <Text style={styles.postMeta}>
              Retning: {activeBearing === null ? "venter på GPS" : directionText(activeBearing)}
            </Text>
            <Text style={styles.postMeta}>
              GPS-nøyaktighet: {location?.coords?.accuracy ? `${Math.round(location.coords.accuracy)} m` : "ukjent"}
            </Text>
          </View>
        ) : null}
      </View>

      <TouchableOpacity style={styles.backButton} onPress={reset}>
        <Text style={styles.backButtonText}>Tilbake</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  menu: {
    flex: 1,
    backgroundColor: "#0F172A",
    justifyContent: "center",
    alignItems: "center",
    padding: 24
  },
  menuTitle: {
    color: "#FFFFFF",
    fontSize: 34,
    fontWeight: "900",
    textAlign: "center",
    marginBottom: 12
  },
  menuText: {
    color: "#94A3B8",
    fontSize: 16,
    lineHeight: 23,
    textAlign: "center",
    marginBottom: 36
  },
  loading: {
    width: "100%",
    backgroundColor: "#1E293B",
    borderRadius: 18,
    padding: 24,
    alignItems: "center"
  },
  loadingText: {
    color: "#E2E8F0",
    marginTop: 14,
    textAlign: "center"
  },
  primaryButton: {
    width: "100%",
    backgroundColor: "#3B82F6",
    borderRadius: 18,
    paddingVertical: 24,
    paddingHorizontal: 18,
    alignItems: "center"
  },
  primaryButtonTitle: {
    color: "#FFFFFF",
    fontSize: 21,
    fontWeight: "900"
  },
  primaryButtonText: {
    color: "rgba(255,255,255,0.82)",
    marginTop: 6,
    fontSize: 14
  },
  game: {
    flexGrow: 1,
    backgroundColor: "#1E3A8A",
    padding: 20,
    justifyContent: "center",
    alignItems: "center"
  },
  title: {
    color: "#FFFFFF",
    fontSize: 31,
    fontWeight: "900",
    marginBottom: 24,
    textAlign: "center"
  },
  card: {
    width: "100%",
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    padding: 22,
    alignItems: "center"
  },
  status: {
    color: "#1F2937",
    fontSize: 21,
    fontWeight: "800",
    lineHeight: 29,
    textAlign: "center"
  },
  meta: {
    color: "#64748B",
    fontSize: 14,
    marginTop: 8,
    textAlign: "center"
  },
  postCard: {
    width: "100%",
    backgroundColor: "#F8FAFC",
    borderColor: "#E2E8F0",
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginTop: 18
  },
  source: {
    color: "#2563EB",
    fontSize: 13,
    fontWeight: "900",
    textTransform: "uppercase",
    marginBottom: 5
  },
  postName: {
    color: "#0F172A",
    fontSize: 19,
    lineHeight: 25,
    fontWeight: "900",
    marginBottom: 10
  },
  postMeta: {
    color: "#334155",
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "600"
  },
  backButton: {
    marginTop: 40,
    borderBottomColor: "#CBD5E1",
    borderBottomWidth: 1,
    paddingBottom: 5
  },
  backButtonText: {
    color: "#CBD5E1",
    fontSize: 16,
    fontWeight: "700"
  }
});