package ddspizza;

import org.springframework.security.provisioning.*;
import org.springframework.security.web.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.*;

@Configuration
public class BasicAuthWebSecurityConfiguration {
  @Autowired
  private AppBasicAuthenticationEntryPoint authenticationEntryPoint;

  @Bean
  public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    http.authorizeRequests()
          .anyRequest().authenticated()
        .and()
          .httpBasic()
          .authenticationEntryPoint(authenticationEntryPoint)
        .and()
          .csrf().disable();;
    return http.build();
  }

  @Bean
  public InMemoryUserDetailsManager userDetailsService() {
    UserDetails user = User.withDefaultPasswordEncoder()
        .username("scanner")
        .password("i will scan")
        .roles("USER_ROLE")
        .build();
    return new InMemoryUserDetailsManager(user);
  }
}