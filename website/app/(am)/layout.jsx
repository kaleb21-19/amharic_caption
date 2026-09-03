import Header from "../../components/Header";
import Footer from "../../components/Footer";

export default function AmharicLayout({ children }) {
  return (
    <>
      <Header lang="am" />
      <main>{children}</main>
      <Footer lang="am" />
    </>
  );
}
